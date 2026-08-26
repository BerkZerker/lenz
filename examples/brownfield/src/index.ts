import { requestReset, consumeReset } from "./auth/reset";
import Mailer from "./mailer";
export { hashPassword } from "./auth/hash";

export function main() {
  const m = new Mailer();
  requestReset("bob@x.com", m);
  consumeReset("tok", "pw");
}
