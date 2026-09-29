import { AppError } from "./errors.ts";

/** JSON.parse that fails as an `invalid` AppError carrying the given code and message. */
export function parseJson(text: string, failure: { code: string; message: string }): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new AppError("invalid", failure.code, failure.message, { cause: err });
  }
}
