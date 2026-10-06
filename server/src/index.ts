import "./env.js";
import { app } from "./app.js";
import { authEnabled } from "./auth.js";

const PORT = Number(process.env.PORT) || 8787;
// Без входа сервер доступен только с этой машины; наружу (HOST=0.0.0.0) — только вместе с AUTH_USERS.
const HOST = process.env.HOST || (authEnabled() ? "0.0.0.0" : "127.0.0.1");
if (!authEnabled() && HOST !== "127.0.0.1" && HOST !== "localhost") {
  console.warn("ВНИМАНИЕ: вход отключён (нет AUTH_USERS), а сервер слушает внешний адрес — данные доступны всем в сети.");
}
app.listen(PORT, HOST, () => {
  console.log(`API сервер запущен: http://${HOST}:${PORT}${authEnabled() ? "" : " (вход отключён: задайте AUTH_USERS)"}`);
});
