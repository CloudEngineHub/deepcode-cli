import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SessionManager, type SessionMessage } from "../session";
import { getCompactPrompt, frameCompactSummary } from "../prompt";
import {
  compactBudget,
  compactPrefixes as selectPrefixes,
  estimateRequestTokens,
  imageOffloadCount,
  isContextOverflow,
} from "../common/compaction";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const directories: string[] = [];
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function message(id: string, role: SessionMessage["role"] = "user", content = "history ".repeat(1000)): SessionMessage {
  return {
    id,
    sessionId: "compact-test",
    role,
    content,
    contentParams: null,
    messageParams: null,
    visible: true,
    compacted: false,
    createTime: "2026-01-01T00:00:00Z",
    updateTime: "2026-01-01T00:00:00Z",
  };
}

function answer(content = "## Current Work\n- Continue the requested implementation.", finish_reason = "stop") {
  return {
    choices: [{ message: { content }, finish_reason }],
    usage: { prompt_tokens: 4000, completion_tokens: 20, total_tokens: 4020 },
  };
}

function fixture(history: SessionMessage[], respond: (request: any, call: number) => unknown = () => answer()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-compaction-"));
  directories.push(root);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const requests: any[] = [];
  const settings = { model: "test-vision", contextWindow: 256 * 1024, autoCompactWindow: 190000 };
  const manager = new SessionManager({
    projectRoot: root,
    createOpenAIClient: () => ({
      model: settings.model,
      thinkingEnabled: true,
      client: {
        chat: {
          completions: {
            create: async (request: any) => {
              requests.push(request);
              return await respond(request, requests.length);
            },
          },
        },
      } as any,
    }),
    getResolvedSettings: () => settings,
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
  const internal = manager as any;
  internal.saveSessionMessages("compact-test", history);
  return {
    manager,
    internal,
    requests,
    settings,
    root,
    read: () => manager.listSessionMessages("compact-test"),
    compact: (signal?: AbortSignal) => manager.compactSession("compact-test", signal),
    run: () => internal.requestSessionCompletion("compact-test", new AbortController().signal, 0),
  };
}

function compactPrefixes(history: SessionMessage[], prices: number[], retain: number) {
  const selection = selectPrefixes(history, prices, retain);
  return selection.ends.map((end) => selection.history.slice(0, end));
}

test("request estimates include reasoning and tools without charging image base64 as text", () => {
  const request = (data: string) => [
    {
      role: "user" as const,
      content: [{ type: "image_url" as const, image_url: { url: `data:image/png;base64,${data}` } }],
    },
  ];
  assert.equal(estimateRequestTokens(request("AA")), estimateRequestTokens(request("A".repeat(1000000))));
  assert.ok(estimateRequestTokens(request("AA")) > 1000);
  assert.ok(
    estimateRequestTokens([{ role: "assistant", content: "", reasoning_content: "x".repeat(10000) } as any]) > 3000
  );
  assert.ok(estimateRequestTokens([], [{ function: { description: "x".repeat(10000) } }]) > 3000);
  assert.equal(compactBudget(262144).threshold, 196608);
  assert.equal(compactBudget(1048576).threshold, Math.floor(1048576 * 0.8));
  assert.equal(compactBudget(262144, 50000).threshold, 50000);
});

test("prefixes preserve complete parallel tool groups, include old summaries and retain the newest unit", () => {
  const summary = { ...message("summary", "system"), meta: { isSummary: true } };
  const call = { ...message("call", "assistant"), messageParams: { tool_calls: [{ id: "a" }, { id: "b" }] } };
  const results = ["a", "b"].map((id) => ({ ...message(id, "tool"), messageParams: { tool_call_id: id } }));
  const history = [message("system", "system"), summary, message("older"), call, ...results];
  assert.deepEqual(
    compactPrefixes(
      history,
      history.map(() => 10),
      0
    ).map((prefix) => prefix.map((m) => m.id)),
    [["summary", "older"], ["summary"]]
  );
  assert.deepEqual(compactPrefixes([message("huge")], [1000000], 0), []);
  assert.deepEqual(compactPrefixes([call, results[0], message("tail")], [10, 10, 10], 0), []);
  const tail = [...history, message("tail")];
  assert.equal(
    compactPrefixes(
      tail,
      tail.map(() => 10),
      0
    )[0].at(-1)?.id,
    "b"
  );
});

test("only explicit context and image capacity errors enable recovery", () => {
  assert.equal(isContextOverflow({ status: 400, error: { code: "context_length_exceeded" } }), true);
  assert.equal(isContextOverflow({ status: 400, message: "maximum context length is 10000 tokens" }), true);
  assert.equal(isContextOverflow({ status: 401, message: "maximum context length" }), false);
  assert.equal(imageOffloadCount({ code: "IMAGE_OFFLOAD_REQUIRED", offloadImages: 3 }), 3);
  assert.equal(imageOffloadCount({ status: 400, message: "Too many images" }), 1);
  assert.equal(imageOffloadCount({ status: 400, message: "Invalid image data" }), 0);
  assert.equal(imageOffloadCount({ status: 413, message: "Request body too large" }), 0);
});

test("compaction instruction and checkpoint framing match the DSH source text", () => {
  // Digest of COMPACTION_INSTRUCTION from the reference DSH summarizer.ts.
  assert.equal(
    createHash("sha256").update(getCompactPrompt()).digest("hex"),
    "3b7aa71f525b9a82afc2f1747c4434ceb7b3bc1fadf8b64c37c4e97db70d074b"
  );
  assert.match(
    frameCompactSummary("checkpoint"),
    /without acknowledging this checkpoint\.\n\n<compacted-summary>\ncheckpoint\n<\/compacted-summary>$/
  );
});

test("native replay preserves multimodal observations and consolidates legacy system summaries", async () => {
  const image = {
    ...message("image", "user", "Slide 3: the title overlaps the chart. " + "details ".repeat(1000)),
    contentParams: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(100000) } }],
  };
  const legacy = { ...message("legacy", "system"), meta: { isSummary: true } };
  const catalog = { ...message("catalog", "system", "Available skills"), meta: { skillCatalog: [] } };
  const archived = { ...message("archived"), compacted: true };
  const f = fixture([
    archived,
    message("system", "system", "System instruction"),
    legacy,
    catalog,
    image,
    message("tail", "user", "continue"),
  ]);
  await f.compact();
  const request = f.requests[0];
  assert.equal(request.messages.at(-1).content, getCompactPrompt());
  assert.equal(request.tool_choice, "none");
  assert.equal(request.max_tokens, 32768);
  assert.ok(request.tools.length > 0);
  assert.ok(
    request.messages.some(
      (m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("<compacted-summary>")
    )
  );
  const replayedImage = request.messages.find((m: any) => Array.isArray(m.content));
  assert.match(replayedImage.content[0].text, /title overlaps/);
  assert.equal(replayedImage.content[1].type, "image_url");
  assert.ok(!request.messages.some((m: any) => typeof m.content === "string" && m.content.includes("AAAA")));
  const saved = f.read();
  assert.equal(saved.find((m) => m.id === "archived")?.content, archived.content);
  assert.equal(saved.find((m) => m.id === "legacy")?.compacted, true);
  assert.equal(saved.find((m) => m.id === "catalog")?.compacted, false);
  assert.equal(saved.filter((m) => m.meta?.isSummary && !m.compacted).length, 1);
  f.internal.appendSessionMessage("compact-test", message("next", "user", "Continue again"));
  // Make this second region large enough for an honest shrink comparison.
  f.internal.appendSessionMessage("compact-test", message("more"));
  f.internal.appendSessionMessage("compact-test", message("last", "user", "next"));
  await f.compact();
  assert.equal(f.read().filter((m) => m.meta?.isSummary && !m.compacted).length, 1);
  assert.match(JSON.stringify(f.requests[1].messages), /compacted-summary/);
});

test("invalid summaries and cancellation leave original history intact", async () => {
  const responses = [
    answer(""),
    answer("partial", "length"),
    answer("x".repeat(100000)),
    { choices: [{ message: { content: "refused", refusal: "no" }, finish_reason: "stop" }] },
    { choices: [{ message: { content: "tool", tool_calls: [{ id: "a" }] }, finish_reason: "tool_calls" }] },
  ];
  for (const response of responses) {
    const history = [message("old"), message("tail", "user", "continue")];
    const f = fixture(history, () => response);
    await assert.rejects(f.compact(), /complete text summary|did not reduce/);
    assert.deepEqual(f.read(), history);
    assert.equal(f.requests.length, 1);
  }
  const history = [message("old"), message("tail")];
  const controller = new AbortController();
  const f = fixture(history, () => {
    controller.abort();
    return answer();
  });
  await assert.rejects(f.compact(controller.signal));
  assert.deepEqual(f.read(), history);
});

test("streamed length finish is retained and rejects a truncated checkpoint", async () => {
  const f = fixture([message("old"), message("tail")], async function* () {
    yield { choices: [{ delta: { content: "partial checkpoint" }, finish_reason: "length" }] };
  });
  await assert.rejects(f.compact(), /complete text summary/);
  assert.ok(f.read().every((m) => !m.compacted));
});

test("summary overflow retries a smaller balanced prefix once", async () => {
  const history = Array.from({ length: 7 }, (_, index) => message(String(index)));
  const f = fixture(history, (_, call) => {
    if (call === 1) throw { status: 400, code: "context_length_exceeded" };
    return answer();
  });
  await f.compact();
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].messages.length < f.requests[0].messages.length);
  const failing = fixture(history, () => {
    throw { status: 400, code: "context_length_exceeded" };
  });
  await assert.rejects(failing.compact());
  assert.equal(failing.requests.length, 2);
  assert.deepEqual(failing.read(), history);
});

test("over-budget summary input is reduced before sending and huge indivisible input fails closed", async () => {
  const f = fixture([message("a"), message("b", "user", "x".repeat(1000000)), message("tail")]);
  await f.compact();
  assert.equal(f.requests.length, 1);
  assert.ok(!JSON.stringify(f.requests[0].messages).includes("x".repeat(100)));
  const huge = fixture([message("huge", "user", "x".repeat(1000000)), message("tail")]);
  await assert.rejects(huge.compact(), /too large/);
  assert.equal(huge.requests.length, 0);
  assert.ok(huge.read().every((m) => !m.compacted));
});

test("image capacity recovery persists omission without deleting the original attachment", async () => {
  const image = {
    ...message("image"),
    contentParams: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
  };
  const f = fixture([image, message("tail")], (_, call) => {
    if (call === 1) throw { status: 400, code: "too_many_images" };
    throw { status: 401, message: "unauthorized" };
  });
  await assert.rejects(f.compact());
  assert.equal(f.requests.length, 2);
  assert.ok(JSON.stringify(f.requests[1].messages).includes("Image omitted:"));
  assert.ok(!JSON.stringify(f.requests[1].messages).includes("base64"));
  assert.deepEqual(f.read()[0].contentParams, image.contentParams);
  assert.deepEqual(f.read()[0].meta?.omittedImages, ["content:0"]);
  assert.ok(f.read().every((m) => !m.compacted));
  const replay = await f.internal.prepareContext(f.read(), f.settings.model, true);
  assert.match(JSON.stringify(replay.messages), /Image omitted:/);
});

test("omitted prompt images are not reloaded from disk", async () => {
  const f = fixture([]);
  const input = {
    ...message("prompt"),
    meta: {
      omittedImages: ["prompt:0"],
      userPrompt: { imageUrls: [pathToFileURL(path.join(f.root, "missing.png")).href] },
    },
  };
  const replay = await f.internal.prepareContext([input], f.settings.model, true);
  assert.match(JSON.stringify(replay.messages), /Image omitted:.*missing.png/);
});

test("normal request overflow forces one useful reduction, then retries without tool execution", async () => {
  const f = fixture([message("old"), message("tail", "user", "continue")], (_, call) => {
    if (call === 1) throw { status: 400, code: "context_length_exceeded" };
    return answer();
  });
  await f.run();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[1].messages.at(-1).content, getCompactPrompt());
  assert.ok(f.read().some((m) => m.compacted));
  const failing = fixture([message("old"), message("tail")], (request) => {
    if (request.tool_choice === "none") return answer();
    throw { status: 400, code: "context_length_exceeded" };
  });
  await assert.rejects(failing.run());
  assert.equal(failing.requests.length, 3);
});

test("fresh large input triggers compaction before the next normal request", async () => {
  const f = fixture([message("old", "user", "a".repeat(60000)), message("tail", "user", "b".repeat(50000))]);
  f.settings.contextWindow = 100000;
  const context = await f.internal.prepareContext(f.read(), f.settings.model, true);
  const measured = f.internal.measureRequest("compact-test", context.messages, f.settings.model);
  f.settings.autoCompactWindow = measured.tokens - 10000;
  await f.run();
  assert.equal(f.requests[0].tool_choice, "none");
  assert.equal(f.requests.length, 2);
});

test("usage anchors include new input and invalidate when history or model changes", async () => {
  const f = fixture([message("old")], () => ({ ...answer(), usage: { prompt_tokens: 100000 } }));
  await f.run();
  const context = await f.internal.prepareContext(f.read(), f.settings.model, true);
  const same = f.internal.measureRequest("compact-test", context.messages, f.settings.model);
  assert.equal(same.tokens, 100000);
  const added = [...context.messages, { role: "user", content: "x".repeat(10000) }];
  assert.ok(f.internal.measureRequest("compact-test", added, f.settings.model).tokens > 103000);
  const changed = f.internal.measureRequest("compact-test", added, "different-model");
  assert.equal(changed.tokens, changed.estimate);
  const rewritten = f.internal.measureRequest("compact-test", [{ role: "user", content: "changed" }], f.settings.model);
  assert.equal(rewritten.tokens, rewritten.estimate);
});

test("concurrent compaction and changed histories cannot commit a stale summary", async () => {
  let release!: (value: unknown) => void;
  const f = fixture(
    [message("old"), message("tail")],
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = f.compact();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.compact(), /already being compacted/);
  f.internal.appendSessionMessage("compact-test", message("new"));
  release(answer());
  await assert.rejects(pending, /changed during compaction/);
  assert.ok(f.read().every((m) => !m.compacted));
  assert.equal(f.read().at(-1)?.id, "new");
});

test("fixed context and an indivisible retained tail cannot cause repeated summary calls", async () => {
  const fixed = fixture([message("system", "system", "x".repeat(1000000)), message("only")]);
  await assert.rejects(fixed.run(), /too large/);
  assert.equal(fixed.requests.length, 0);
  assert.ok(fixed.read().every((m) => !m.compacted));

  const tail = fixture([message("old"), message("tail", "user", "x".repeat(1000000))]);
  await assert.rejects(tail.run(), /too large|did not reduce/);
  assert.ok(tail.requests.length <= 2);
  assert.ok(tail.requests.every((request) => request.tool_choice === "none"));
  assert.equal(tail.read().find((m) => m.id === "tail")?.compacted, false);
});

test("new parallel tool results are measured before requesting another assistant step", async () => {
  const call = {
    ...message("call", "assistant", ""),
    messageParams: {
      tool_calls: [
        { id: "a", type: "function", function: { name: "Read", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "Read", arguments: "{}" } },
      ],
    },
  };
  const results = ["a", "b"].map((id) => ({
    ...message(id, "tool", "x".repeat(30000)),
    messageParams: { tool_call_id: id },
  }));
  const f = fixture([message("old", "user", "y".repeat(60000)), call, ...results]);
  f.settings.contextWindow = 100000;
  const context = await f.internal.prepareContext(f.read(), f.settings.model, true);
  f.settings.autoCompactWindow =
    f.internal.measureRequest("compact-test", context.messages, f.settings.model).tokens - 10000;
  await f.run();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].tool_choice, "none");
  const normal = f.requests[1].messages;
  assert.equal(normal.filter((m: any) => m.role === "tool").length, 2);
  assert.equal(normal.find((m: any) => m.role === "assistant").tool_calls.length, 2);
});

test("image recovery terminates when no retained image remains", async () => {
  const image = {
    ...message("image"),
    contentParams: [0, 1].map((index) => ({
      type: "image_url",
      image_url: { url: `https://example.com/${index}.png` },
    })),
  };
  const f = fixture([image, message("tail")], () => {
    throw { status: 400, code: "too_many_images" };
  });
  await assert.rejects(f.run());
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.read()[0].meta?.omittedImages, ["content:0", "content:1"]);
  assert.ok(f.read().every((m) => !m.compacted));
});

test("non-capacity errors do not compact or omit images", async () => {
  const image = {
    ...message("image"),
    contentParams: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
  };
  const history = [image, message("tail")];
  const f = fixture(history, () => {
    throw { status: 401, message: "Unauthorized" };
  });
  await assert.rejects(f.run());
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.read(), history);
});

test("summary requests share Files API upload and expired-reference recovery", async () => {
  const image = {
    ...message("image"),
    contentParams: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
  };
  const f = fixture([image, message("tail")], (_, call) => {
    if (call === 1) throw Object.assign(new Error("file id expired"), { status: 400 });
    return answer();
  });
  const originalClient = f.internal.createOpenAIClient;
  f.internal.createOpenAIClient = () => ({ ...originalClient(), apiKey: "test-key" });
  Object.assign(f.settings, { filesApiEnabled: true });
  let uploads = 0;
  let invalidations = 0;
  f.internal.deepSeekFiles = {
    ensureUploaded: async () => ({ fileId: `file-${++uploads}`, imageHash: "a".repeat(64), bytes: 3 }),
    invalidate: () => {
      invalidations++;
    },
  };
  await f.compact();
  assert.equal(uploads, 2);
  assert.equal(invalidations, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].messages.at(-1).content, getCompactPrompt());
  assert.match(JSON.stringify(f.requests[1].messages), /file-2/);
  assert.doesNotMatch(JSON.stringify(f.requests[1].messages), /base64/);
});
