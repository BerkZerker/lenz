import { hashPassword } from "./hash";
import type Mailer from "../mailer";

// token store
export const tokens = new Map<string, number>();

export function requestReset(email: string, mailer: Mailer): string {
  const token = Math.random().toString(36).slice(2);
  tokens.set(token, Date.now());
  mailer.send(email, token);
  return token;
}

export async function consumeReset(token: string, password: string) {
  const at = tokens.get(token);
  if (!at) return 410;
  tokens.delete(token);
  return hashPassword(password);
}

export class ResetError extends Error {
  code = 410;
  describe() { return `${this.code}: ${this.message}`; }
}
