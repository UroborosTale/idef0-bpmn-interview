import { hashPassword } from "../util/password.js";

// Печатает хэш пароля для AUTH_USERS: AUTH_USERS=analyst:<хэш>
const password = process.argv[2];
if (!password) {
  console.error("Использование: npm run hash-password -w server -- <пароль>");
  process.exit(1);
}
console.log(hashPassword(password));
