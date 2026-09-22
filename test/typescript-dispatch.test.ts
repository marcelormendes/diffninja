import { describe, expect, test } from "vitest";
import { extractCached, extractFunctions, type ExtractionCache } from "../src/extract.js";
import { resolveDispatchContext } from "../src/languages/typescript-dispatch.js";
import type { DispatchEdge } from "../src/languages/typescript-dispatch.js";
import type { FunctionInfo } from "../src/types.js";

/** Extract fixture files the way a review run does, one file at a time. */
function extract(files: Record<string, string>): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  for (const [file, source] of Object.entries(files)) {
    functions.push(...extractFunctions(file, source));
  }
  return functions;
}

/** Dispatch sites recorded on the extracted functions, with their owners. */
function dispatchesOf(functions: readonly FunctionInfo[]) {
  return functions.flatMap((fn) => (fn.review?.dispatches ?? []).map((record) => ({ fn, record })));
}

function edgesOf(files: Record<string, string>): DispatchEdge[] {
  return resolveDispatchContext(extract(files));
}

function keyed(functions: readonly FunctionInfo[], key: string): FunctionInfo {
  const found = functions.find((fn) => fn.key === key);
  if (!found) throw new Error(`fixture has no function ${key}`);
  return found;
}

/** Evidence of every edge, which is where a match states how it was made. */
function evidenceOf(edges: readonly DispatchEdge[]): string {
  return edges.map((edge) => edge.evidence).join("\n");
}

/**
 * An event enum, an emitter and the listener registered for one of its keys.
 * `LeaseCreated` is emitted with no listener, so only `LeaseUpdated` links.
 */
const EVENT_FILES = {
  "src/dispatch/events.ts": [
    "export enum TypedEvents {",
    "  LeaseCreated = 'lease.created',",
    "  LeaseUpdated = 'lease.updated',",
    "}",
  ].join("\n"),
  "src/dispatch/lease.service.ts": [
    'import { TypedEvents } from "./events";',
    "export class LeaseService {",
    "  constructor(private readonly emitter: Emitter) {}",
    "  async update(id: string) {",
    "    await this.emitter.emitAsync(TypedEvents.LeaseUpdated, { id });",
    "  }",
    "  async create(id: string) {",
    "    await this.emitter.emitAsync(TypedEvents.LeaseCreated, { id });",
    "  }",
    "}",
  ].join("\n"),
  "src/dispatch/lease.listener.ts": [
    'import { OnTypedEvent, TypedEvents } from "./events";',
    "@Injectable()",
    "export class LeaseListener {",
    "  @OnTypedEvent(TypedEvents.LeaseUpdated, { async: true })",
    "  async onLeaseUpdated(event: Event) {",
    "    await this.work(event);",
    "  }",
    "  private async work(event: Event) { go(); }",
    "}",
  ].join("\n"),
};

/** A queue whose job key the producer names by enum member and the consumer by literal. */
const QUEUE_FILES = {
  "src/dispatch/jobs.ts": [
    "export enum LeaseJobName {",
    "  PROCESS_UPDATED_LEASE = 'process-updated-lease',",
    "  PROCESS_UPDATED_TENANT = 'process-updated-tenant',",
    "}",
    "export enum QueueName { LEASE = '{lease-queue}' }",
  ].join("\n"),
  "src/dispatch/producer.ts": [
    'import { InjectQueue } from "@nestjs/bullmq";',
    'import { LeaseJobName, QueueName } from "./jobs";',
    "@Injectable()",
    "export class LeaseProducer {",
    "  constructor(@InjectQueue(QueueName.LEASE) private readonly queue: LeaseQueue) {}",
    "  async enqueue() {",
    "    await this.queue.add(LeaseJobName.PROCESS_UPDATED_LEASE, { id: 1 });",
    "  }",
    "}",
  ].join("\n"),
  "src/dispatch/consumer.ts": [
    'import { Processor, WorkerHost } from "@nestjs/bullmq";',
    'import { QueueName } from "./jobs";',
    "@Processor(QueueName.LEASE)",
    "export class LeaseConsumer extends WorkerHost {",
    "  async process(job: Job) {",
    "    switch (job.name) {",
    "      case 'process-updated-lease':",
    "        await this.sync.syncUpdatedLease(job.data);",
    "        break;",
    "      case 'process-updated-tenant':",
    "        await this.sync.syncUpdatedTenant(job.data);",
    "        break;",
    "    }",
    "  }",
    "}",
  ].join("\n"),
};

describe("event dispatch", () => {
  test("links an emitter to the listener registered for its key", () => {
    const functions = extract(EVENT_FILES);
    const edges = resolveDispatchContext(functions);

    expect(edges).toHaveLength(1);
    const [edge] = edges;
    expect(edge.kind).toBe("event");
    expect(edge.owner.key).toBe("LeaseService.update");
    expect(edge.owner.file).toBe("src/dispatch/lease.service.ts");
    // The edge is located at the emit call, which is the line context renders.
    expect(edge.line).toBe(5);
    expect(edge.target.key).toBe("LeaseListener.onLeaseUpdated");
    expect(edge.target.file).toBe("src/dispatch/lease.listener.ts");
    // Context reads the target's body from its span, so it must be known.
    expect(edge.target.line).toBeDefined();
    expect(edge.evidence).toContain("key value 'lease.updated'");
    expect(edge.evidence).toContain("resolved from TypedEvents.LeaseUpdated");
    expect(edge.evidence).toContain("@OnTypedEvent(TypedEvents.LeaseUpdated) on LeaseListener.onLeaseUpdated");
    expect(edge.evidence).toContain("not a runtime call or proof of delivery");
  });

  test("leaves an emitted key with no listener unconnected", () => {
    const edges = resolveDispatchContext(extract(EVENT_FILES));
    expect(edges.map((edge) => edge.owner.key)).not.toContain("LeaseService.create");
  });

  test("reads stacked event decorators as one handler per key", () => {
    const functions = extract({
      "src/dispatch/events.ts": "export enum E { A = 'a.event', B = 'b.event' }\n",
      "src/dispatch/listener.ts": [
        'import { OnTypedEvent, E } from "./events";',
        "export class L {",
        "  @OnTypedEvent(E.A)",
        "  @OnTypedEvent(E.B)",
        "  async onAnything(event: Event) { go(); }",
        "}",
      ].join("\n"),
      "src/dispatch/producer.ts": [
        'import { E } from "./events";',
        "export class P {",
        "  async go() { this.emitter.emit(E.B, {}); }",
        "}",
      ].join("\n"),
    });
    const keys = functions
      .flatMap((fn) => fn.review?.dispatches ?? [])
      .filter((record) => record.direction === "handle")
      .map((record) => record.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);

    const edges = resolveDispatchContext(functions);
    expect(edges).toHaveLength(1);
    expect(edges[0].target.key).toBe("L.onAnything");
    expect(edges[0].evidence).toContain("resolved from E.B");
  });

  test("never links a handler back to itself", () => {
    const edges = edgesOf({
      "src/dispatch/loop.ts": [
        "export class L {",
        "  @OnEvent('ping')",
        "  onPing(event: Event) { this.emitter.emit('ping', event); }",
        "}",
      ].join("\n"),
    });
    expect(edges).toHaveLength(0);
  });
});

describe("queue dispatch", () => {
  test("links an enqueued enum key to the switch case handling its value", () => {
    const functions = extract(QUEUE_FILES);
    const edges = resolveDispatchContext(functions);

    expect(edges).toHaveLength(1);
    const [edge] = edges;
    expect(edge.kind).toBe("queue");
    expect(edge.owner.key).toBe("LeaseProducer.enqueue");
    expect(edge.line).toBe(7);
    expect(edge.target.key).toBe("LeaseConsumer.process");
    expect(edge.target.file).toBe("src/dispatch/consumer.ts");
    expect(edge.evidence).toContain("key value 'process-updated-lease'");
    expect(edge.evidence).toContain("resolved from LeaseJobName.PROCESS_UPDATED_LEASE");
    expect(edge.evidence).toContain("channel '{lease-queue}'");
    expect(edge.evidence).toContain("case 'process-updated-lease' of switch (job.name)");
  });

  test("records every case while linking only the matching one", () => {
    const functions = extract(QUEUE_FILES);
    const cases = dispatchesOf(functions).map(({ record }) => record.evidence);
    expect(cases.some((evidence) => evidence.includes("case 'process-updated-tenant'"))).toBe(true);
    expect(evidenceOf(resolveDispatchContext(functions))).not.toContain("process-updated-tenant");
  });

  test("links a literal job key to a case written the same way", () => {
    const edges = edgesOf({
      "src/dispatch/producer.ts": [
        "export class P {",
        "  constructor(@InjectQueue('{q}') private readonly queue: CQueue) {}",
        "  async go() { await this.queue.add('job-a', {}); }",
        "}",
      ].join("\n"),
      "src/dispatch/consumer.ts": [
        "@Processor('{q}')",
        "export class C extends WorkerHost {",
        "  async process(job: Job) {",
        "    if (job.name === 'job-a') go();",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].evidence).toContain("if (job.name === 'job-a')");
  });

  test("links a key registered by @Process on the consumer method", () => {
    const edges = edgesOf({
      "src/dispatch/queue.ts": [
        "export class Q {",
        "  constructor(@InjectQueue('{q}') private readonly queue: CQueue) {}",
        "  async go() { await this.queue.add('named-job', {}); }",
        "}",
        "@Processor('{q}')",
        "export class Worker extends WorkerHost {",
        "  @Process('named-job')",
        "  async handle(job: Job) { await this.sync.run(job.data); }",
        "}",
      ].join("\n"),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].target.key).toBe("Worker.handle");
    expect(edges[0].evidence).toContain("@Process('named-job') on Worker.handle");
  });
});

describe("dispatch honesty", () => {
  test("leaves a job key no consumer handles unconnected", () => {
    const functions = extract({
      "src/dispatch/producer.ts": [
        "export class P {",
        "  constructor(@InjectQueue('{q}') private readonly queue: CQueue) {}",
        "  async go() { await this.queue.add('job-a', {}); }",
        "}",
      ].join("\n"),
      "src/dispatch/consumer.ts": [
        "@Processor('{q}')",
        "export class C extends WorkerHost {",
        "  async process(job: Job) { switch (job.name) { case 'job-b': go(); } }",
        "}",
      ].join("\n"),
    });
    // Both sides are read; neither is guessed into a link.
    expect(dispatchesOf(functions)).toHaveLength(2);
    expect(resolveDispatchContext(functions)).toHaveLength(0);
  });

  test("never crosses two queues that reuse one job name", () => {
    const functions = extract({
      "src/dispatch/a.ts": [
        "export class A {",
        "  constructor(@InjectQueue('{queue-a}') private readonly queue: AQueue) {}",
        "  async go() { await this.queue.add('shared-job', {}); }",
        "}",
        "@Processor('{queue-b}')",
        "export class B extends WorkerHost {",
        "  async process(job: Job) { if (job.name === 'shared-job') go(); }",
        "}",
      ].join("\n"),
    });
    const evidence = dispatchesOf(functions).map(({ record }) => record.evidence).join("\n");
    expect(evidence).toContain("@InjectQueue('{queue-a}')");
    expect(evidence).toContain("@Processor('{queue-b}')");
    expect(resolveDispatchContext(functions)).toHaveLength(0);
  });

  test("records nothing for keys that are not static", () => {
    const functions = extract({
      "src/dispatch/producer.ts": [
        "export class P {",
        "  constructor(@InjectQueue('{q}') private readonly queue: CQueue) {}",
        "  async go(jobName: string, keys: string[], set: Set<string>, element: El) {",
        "    await this.queue.add(jobName, {});",
        "    await this.queue.add(`dynamic-${jobName}`, {});",
        "    await this.queue.add(keys[0], {});",
        "    set.add(jobName);",
        "    element.classList.add('collapsed');",
        "    await this.other.add('looks-like-a-job', {});",
        "    this.emitter.emit(getKey(), 1);",
        "    this.emitter.on('subscribed', handler);",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(dispatchesOf(functions)).toHaveLength(0);
  });

  test("matches identical static member paths when no value is known", () => {
    const edges = edgesOf({
      "src/dispatch/a.ts": [
        "export class A {",
        "  constructor(@InjectQueue(BullMqQueue.LEASE) private readonly queue: AQueue) {}",
        "  async go() { await this.queue.add(JobName.PROCESS, {}); }",
        "}",
        "@Processor(BullMqQueue.LEASE)",
        "export class B extends WorkerHost {",
        "  async process(job: Job) { if (job.name === JobName.PROCESS) go(); }",
        "}",
      ].join("\n"),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].evidence).toContain("identical static key path JobName.PROCESS");
    expect(edges[0].evidence).toContain("unresolved member path");
  });

  test("keeps callable metadata and attaches records to the owning function", () => {
    const functions = extract({
      "src/dispatch/producer.ts": [
        "export class P {",
        "  constructor(@InjectQueue('{q}') private readonly queue: CQueue) {}",
        "  @Log()",
        "  async go(jobName: string) {",
        "    await this.queue.add('named-job', { jobName });",
        "  }",
        "}",
      ].join("\n"),
    });
    const producer = keyed(functions, "P.go");
    // The span still starts at the decorator, as the TypeScript extractor left it.
    expect(producer.line).toBe(3);
    expect(producer.params?.text).toBe("(jobName: string)");
    expect(producer.steps).toHaveLength(1);
    const [dispatch] = producer.review?.dispatches ?? [];
    expect(dispatch?.direction).toBe("emit");
    expect(dispatch?.kind).toBe("queue");
    expect(dispatch?.line).toBe(5);
    expect(dispatch?.evidence).toContain("@InjectQueue('{q}')");
  });
});

test("resolves constants from the indexed snapshot, including cache hits", () => {
  const cache: ExtractionCache = new Map();
  const snapshot = (event: string) => [
    ...extractCached("events.ts", `export enum Events { Updated = '${event}' }`, cache),
    ...extractCached("publisher.ts", "export function publish() { bus.emit(Events.Updated, {}); }", cache),
    ...extractCached("listener.ts", "export class Listener { @OnEvent('old') updated() {} }", cache),
  ];
  const before = snapshot("old");
  const after = snapshot("new");
  expect(resolveDispatchContext(before).map(edge => edge.target.key)).toEqual(["Listener.updated"]);
  expect(resolveDispatchContext(after)).toEqual([]);
  expect(resolveDispatchContext(snapshot("old")).map(edge => edge.target.key)).toEqual(["Listener.updated"]);
});

describe("tsx dispatch", () => {
  test("follows a component's emitter to the listener registered elsewhere", () => {
    const edges = edgesOf({
      "src/dispatch/view.tsx": [
        "export function View() {",
        "  const submit = () => emitter.emit('form.submitted', { ok: true });",
        "  return <Button onClick={submit} />;",
        "}",
      ].join("\n"),
      "src/dispatch/listener.tsx": [
        "export class FormListener {",
        "  @OnEvent('form.submitted')",
        "  onSubmitted(event: Event) { track(event); }",
        "}",
      ].join("\n"),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].owner.file).toBe("src/dispatch/view.tsx");
    expect(edges[0].owner.key).toBe("submit");
    expect(edges[0].target.file).toBe("src/dispatch/listener.tsx");
    expect(edges[0].target.key).toBe("FormListener.onSubmitted");
    expect(edges[0].evidence).toContain("key value 'form.submitted'");
  });
});

describe("empty input", () => {
  test("resolves nothing from functions without dispatch sites", () => {
    const functions = extract({
      "src/dispatch/plain.ts": "export function run() { helper(); }\nfunction helper() {}\n",
    });
    expect(dispatchesOf(functions)).toHaveLength(0);
    expect(resolveDispatchContext(functions)).toHaveLength(0);
  });
});
