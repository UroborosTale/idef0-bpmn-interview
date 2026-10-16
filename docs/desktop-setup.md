# Настольное приложение: окружение, сборка, запуск

`desktop/ProcessStudio` — оболочка на .NET 8 (WinForms + WebView2), в которой студия работает в браузерном
компоненте, а на месте холста диаграммы — установленный Visio. Оболочка сама поднимает Node-сервер приложения и
отдаёт через него и `/api`, и собранный веб-интерфейс (`web/dist`).

## Что нужно на машине

| Требование | Зачем | Проверка |
|---|---|---|
| .NET 8 Desktop Runtime (x64) | без него `ProcessStudio.exe` не запускается: «Failed to resolve hostfxr.dll» | `dotnet --list-runtimes` |
| Visio 2016+ x64 | компонент «Microsoft Visio 16.0 Drawing Control» встраивается в окно | наличие `VISIO.EXE` |
| WebView2 Runtime | интерфейс студии внутри окна | есть в Windows 10/11 по умолчанию |
| Node.js 20+ и `node_modules` | сервер и сборка клиента | `node -v` |
| Собранный `web/dist` | оболочка отдаёт собранный клиент, а не dev-сервер Vite | `npm run build -w web` |

## Как .NET поставлен на этой машине (16.10.2026)

Прав администратора не было, поэтому runtime установлен **для пользователя**:

- каталог: `C:\Users\ErshovEM\AppData\Local\Microsoft\dotnet` (папки `host`, `shared`, `dotnet.exe`);
- версии: `Microsoft.NETCore.App 8.0.32` + `Microsoft.WindowsDesktop.App 8.0.32`;
- в переменные пользователя прописаны `DOTNET_ROOT` и `DOTNET_ROOT_X64` на этот каталог — по ним apphost находит
  runtime, и запуск двойным щелчком по exe тоже работает.

**Почему не обычным установщиком.** В сети прямой доступ наружу закрыт, всё идёт через корпоративный прокси
(`HTTPS_PROXY` с учётными данными). Официальный `dotnet-install.ps1` через него не скачивает пакет
(`aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.tar.gz` недоступен), а `Invoke-WebRequest` в PowerShell 5.1 не
берёт прокси из переменных окружения. Рабочий обход — скачать архивы `curl.exe` (он прокси уважает) и распаковать:

```powershell
$dir = "$env:LOCALAPPDATA\Microsoft\dotnet"
curl.exe -sSL -o "$env:TEMP\wd.zip" "https://builds.dotnet.microsoft.com/dotnet/WindowsDesktop/8.0.32/windowsdesktop-runtime-8.0.32-win-x64.zip"
curl.exe -sSL -o "$env:TEMP\rt.zip" "https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.32/dotnet-runtime-8.0.32-win-x64.zip"
Expand-Archive "$env:TEMP\wd.zip" -DestinationPath $dir -Force   # desktop-часть
Expand-Archive "$env:TEMP\rt.zip" -DestinationPath $dir -Force   # dotnet.exe, host, NETCore.App
[Environment]::SetEnvironmentVariable('DOTNET_ROOT', $dir, 'User')
[Environment]::SetEnvironmentVariable('DOTNET_ROOT_X64', $dir, 'User')
```

Оба архива нужны: в `windowsdesktop-runtime-*.zip` нет `dotnet.exe` — он в базовом `dotnet-runtime-*.zip`.

**Удалить** — снести каталог `%LOCALAPPDATA%\Microsoft\dotnet` и переменные `DOTNET_ROOT` / `DOTNET_ROOT_X64`.
Система при этом не менялась.

## Сборка оболочки

**16.10.2026 SDK установлен** тем же обходом, без прав администратора: `%LOCALAPPDATA%\Microsoft\dotnet\sdk\8.0.426`
(+ `Microsoft.AspNetCore.App` 8.0.32 рядом с рантаймами). Пересборка теперь доступна:

```powershell
$dotnet = "$env:LOCALAPPDATA\Microsoft\dotnet\dotnet.exe"
cd desktop\ProcessStudio
& $dotnet build -c Release          # если приложение запущено, exe занят — сначала закройте окно
& $dotnet build -c Release -t:Compile   # только проверка компиляции, без записи в bin
```

Если SDK понадобится поставить заново (или на другой машине) — тем же способом, без `-Runtime`:

```powershell
$dir = "$env:LOCALAPPDATA\Microsoft\dotnet"
curl.exe -sSL -o "$env:TEMP\sdk.zip" "https://builds.dotnet.microsoft.com/dotnet/Sdk/8.0.426/dotnet-sdk-8.0.426-win-x64.zip"
# Expand-Archive на этом архиве спотыкается о служебный файл .toolsetversion, поэтому через ZipFile:
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory("$env:TEMP\sdk.zip", "$env:TEMP\sdk-stage")
robocopy "$env:TEMP\sdk-stage" $dir /E /NFL /NDL /NJH /NJS /NP
```

## Запуск

```powershell
$repo = 'C:\Users\ErshovEM\Desktop\проекты\process-modeling-app'
& "$repo\desktop\ProcessStudio\bin\Release\net8.0-windows\ProcessStudio.exe" --repo $repo
```

Аргументы (см. `Program.cs`): `--repo <корень репозитория>` (по умолчанию вычисляется от папки exe), `--data <каталог
данных>` (по умолчанию `server\data` — та же база, что у `npm run dev:server`; база в режиме WAL, два процесса
работают параллельно), `--selftest <папка отчёта>` — самопроверка без участия человека.

Закрытие окна останавливает и поднятый сервер: оболочка гасит дерево процессов node.

## Самопроверка (`--selftest`)

## Корпоративный прокси и TLS

Если сервер отвечает `LLM не обработал ни одного фрагмента: fetch failed`, а `curl https://api.mistral.ai/v1/models` даёт
`401` — сеть подменяет TLS самоподписанным сертификатом, и Node его не доверяет (Node не читает хранилище сертификатов
Windows). Выгрузите корневые сертификаты в PEM и запускайте сервер с `NODE_EXTRA_CA_CERTS`:

```powershell
$pem = "$env:TEMP\pm-ca.pem"
$sb = New-Object System.Text.StringBuilder
foreach ($s in @('Cert:\LocalMachine\Root','Cert:\LocalMachine\CA','Cert:\CurrentUser\Root')) {
  foreach ($c in Get-ChildItem $s -ErrorAction SilentlyContinue) {
    $b = [Convert]::ToBase64String($c.RawData)
    [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
    for ($i = 0; $i -lt $b.Length; $i += 64) { [void]$sb.AppendLine($b.Substring($i, [Math]::Min(64, $b.Length - $i))) }
    [void]$sb.AppendLine('-----END CERTIFICATE-----')
  }
}
[IO.File]::WriteAllText($pem, $sb.ToString())
$env:NODE_EXTRA_CA_CERTS = $pem
npm run dev:server
```

Проверка: `node -e "fetch('https://api.mistral.ai/v1/models').then(r=>console.log(r.status)).catch(e=>console.log('ERR',e.message))"`
— при рабочем сертификате `401`, иначе `ERR fetch failed` с причиной `SELF_SIGNED_CERT_IN_CHAIN`. Тот же файл нужен для
разбора текста без веб-приложения: `cd server; $env:NODE_EXTRA_CA_CERTS=$pem; npx tsx src/scripts/run-pipeline.ts <id сессии>`.


```powershell
& "$repo\desktop\ProcessStudio\bin\Release\net8.0-windows\ProcessStudio.exe" --selftest "$env:TEMP\pm-desktop-selftest" --repo $repo
```

Что проверяет: Visio встаёт на место холста и открывает нужную страницу, палитра рисует фигуры, «Записать правки» и
повторный приём не создают дубликатов, выделение синхронно в обе стороны, авто-приём правок, масштаб, сетка, переходы
BPMN ↔ IDEF0, переименование в Visio попадает в модель.

Отчёт: `<папка отчёта>\selftest.log` (+ `progress.log`, `web.png`, `visio-idef0.png`); база — временная, ваша не
затрагивается. Признак успеха — в отчёте нет слов «ПРОВАЛ» и «ОШИБКА». Проверка идёт на живом Visio, поэтому требует
рабочего стола (не подходит для службы без сеанса).

## Если включать вход (`AUTH_USERS`) — сначала доработать оболочку

Сейчас вход отключён, и сервер слушает только `127.0.0.1`. При включении `AUTH_USERS` есть две ловушки:

1. `server/src/index.ts`: `HOST` по умолчанию становится `0.0.0.0`, то есть сервер открывается на всю сеть. Если это
   не нужно — задавайте `HOST=127.0.0.1` явно.
2. Оболочка обращается к API **без заголовка авторизации**, а её ручки не входят в список публичных
   (`server/src/auth.ts`, `PUBLIC`). При включённом входе отвалятся: `VisioPane.cs:54` (выгрузка `.vsdx`),
   `VisioPane.cs:266` (значки событий), `VisioPane.cs:578` (приём правок) и чтение модели в `Program.cs:452–551`.
   Значит к включению входа нужна правка: либо внутренний токен для loopback-запросов оболочки, либо логин оболочки
   тем же пользователем.

Для MCP-агентов не забыть `AGENT_API_TOKEN` — при включённом входе агент входит только по нему и только в
`/api/agent/*` (см. `docs/agents/README.md`).

