import { appEnv, db } from "./context";
import type { QueueEvent } from "./events";

// Turns queue events into the repository activity feed. Push events get a one-line Workers AI summary.
export async function consume(batch: MessageBatch<QueueEvent>): Promise<void> {
  const data = db();
  for (const message of batch.messages) {
    const event = message.body;
    try {
      const summary = event.type === "push" ? await summarizePush(event) : null;
      await data.addEvent({
        repoId: event.repoId,
        actorId: event.actorId,
        type: event.type,
        payload: event,
        summary,
      });
      if (event.type === "repo.imported") {
        await data.updateRepo(event.repoId, { import_status: "running" });
      }
      message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}

async function summarizePush(event: Extract<QueueEvent, { type: "push" }>): Promise<string | null> {
  const lines = event.updates.map((update) => {
    const kind = update.oldSha.startsWith("0000")
      ? "created"
      : update.newSha.startsWith("0000")
        ? "deleted"
        : "updated";

    return `${kind} ${update.name} ${update.newSha.slice(0, 7)}`;
  });
  const prompt = `Summarize this git push in one short sentence for an activity feed. Facts only.\n${lines.join("\n")}\nObjects received: ${event.objects}`;
  try {
    // SAFETY: @cf/meta/llama-3.1-8b-instruct-fast postdates the AiModels catalogue in workers-types, so the
    // model id and its chat input go through untyped; text generation answers with { response }.
    const result = (await appEnv().AI.run(
      "@cf/meta/llama-3.1-8b-instruct-fast" as never,
      {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 60,
      } as never,
    )) as { response?: string };

    return result.response?.trim().split("\n")[0] ?? null;
  } catch {
    return lines.join(", ");
  }
}
