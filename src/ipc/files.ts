// T13.3 / T13.4: typed wrappers around the `read_text_file` / `write_text_file`
// Tauri commands.
//
// Path-scoped on both sides: the Rust side canonicalizes
// `projectRoot` + `relativePath` and rejects anything that escapes
// the project. The read response distinguishes text from binary so
// the UI can render Monaco vs. a "not a text file" placeholder without
// guessing; the write side round-trips the encoding tag so a file that
// had a UTF-8 BOM on disk gets one written back.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const TextEncodingSchema = z.union([z.literal("utf-8"), z.literal("utf-8-bom")]);

const BinaryReasonSchema = z.union([z.literal("nul-byte"), z.literal("not-utf-8")]);

const ReadResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    content: z.string(),
    encoding: TextEncodingSchema,
  }),
  z.object({
    kind: z.literal("binary"),
    reason: BinaryReasonSchema,
  }),
]);

export type TextEncoding = z.infer<typeof TextEncodingSchema>;
export type BinaryReason = z.infer<typeof BinaryReasonSchema>;
export type ReadFileResult = z.infer<typeof ReadResultSchema>;

export async function readTextFile(
  projectRoot: string,
  relativePath: string,
): Promise<ReadFileResult> {
  const raw = await invoke<unknown>("read_text_file", {
    projectRoot,
    relativePath,
  });
  return ReadResultSchema.parse(raw);
}

export async function writeTextFile(
  projectRoot: string,
  relativePath: string,
  content: string,
  encoding: TextEncoding = "utf-8",
): Promise<void> {
  await invoke<unknown>("write_text_file", {
    projectRoot,
    relativePath,
    content,
    encoding,
  });
}
