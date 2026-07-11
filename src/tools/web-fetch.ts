// Fetch the readable content of a URL the model provides. No API key, no search
// backend — just an HTTP GET with a hard timeout, HTML reduced to text, output
// capped. Network egress is user-approved (permission: ask) since an untrusted
// model chooses the URL.

import { z } from "zod";
import { capOutput, type Tool, type ToolPreview } from "./registry.js";

const schema = z.object({
  url: z.string().url().describe("Absolute http(s) URL to fetch (e.g. a docs or API reference page)"),
});

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000; // don't pull huge pages into memory

/** Reduce an HTML document to readable text. Deliberately simple — no parser dep. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br|hr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#3?9;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webFetchTool: Tool<z.infer<typeof schema>> = {
  name: "web_fetch",
  description:
    "Fetch the text content of an http(s) URL (docs, API references, raw files). " +
    "HTML is reduced to readable text. Requires user approval. Cannot search — pass a specific URL.",
  schema,
  readOnly: true,
  permission: "ask",
  async preview(input): Promise<ToolPreview | null> {
    return { kind: "command", text: `GET ${input.url}` };
  },
  async execute(input) {
    let res: Response;
    try {
      res = await fetch(input.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "omcode", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError") return `Fetch timed out after ${TIMEOUT_MS / 1000}s: ${input.url}`;
      return `Could not fetch ${input.url}: ${e.message}. Check the URL is reachable and absolute (https://…).`;
    }

    if (!res.ok) {
      return `HTTP ${res.status} ${res.statusText} for ${input.url}. The page may require auth or not exist.`;
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const textual = /text\/|application\/(json|xml|.*\+xml|.*javascript|x-ndjson)/.test(contentType);
    if (contentType && !textual) {
      return `Refused: ${input.url} is ${contentType.split(";")[0]}, not text. web_fetch only returns text/HTML/JSON.`;
    }

    let raw: string;
    try {
      const buf = await res.arrayBuffer();
      raw = new TextDecoder("utf-8").decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
    } catch (err) {
      return `Could not read the response body from ${input.url}: ${(err as Error).message}`;
    }

    const isHtml = /html/.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
    const body = isHtml ? htmlToText(raw) : raw.trim();
    if (!body) return `Fetched ${input.url} but it had no readable text content.`;
    return capOutput(`${input.url}\n\n${body}`, "The page is long — ask for a more specific URL or section.");
  },
};
