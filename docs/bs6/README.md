# Business Studio 6: изучение установки

Материалы разбора Business Studio 6 (сборка 6.1.9320, `C:\Program Files (x86)\STU-Soft\Business Studio 6`) — как эталон функций для нашего редактора IDEF0/BPMN. Собрано по штатно поставляемым файлам BS (метамодель, ресурсы, схема портала) и по метаданным сборок через REA (`rea-dotnet-static`, только метаданные: типы, поля, методы, токены строк — без дампа тел методов).

## Что это за программа

| Компонент | Что внутри |
|---|---|
| Настольный клиент | .NET 4.0: `BizArch.Client/Server.dll`, `AppPlatform.Client/Server.dll`, `Sys.*`, `CRM.*`, DevExpress UI, встроенный Visio (`Microsoft.Office.Interop.Visio`) и браузер (EO.WebBrowser), `Roslyn` |
| Visio-аддон | `VSAddIn.Engine.dll` (движок: `ИсточникМД`, `SourceSafe`, `Config`, `ExcelOperations`), `VSAddIn.ToolWindows.dll` (UI: свойства, выбор класса/перечисления, **конструктор метамодели** `Byte.ORM.MD`, `DBUpdater`) |
| Веб-платформа | `HtmlServerAssets` (142 МБ, yFiles-редактор, карт исходников нет), `BS_WebService` (AspNetCore), `AppPlatform.Node` (850 МБ, Node + Chrome) |
| Хранилища | PostgreSQL (модель: схема **выводится из метамодели**, 2081 `Stored`-свойство), MySQL 8.4.4 (портал, 22 таблицы) |

## Ключевые выводы

- **BS — «метамодель как программа»**: из `Metadata\1.0.0.5\*.mdm` генерируются схема БД, панель свойств в Visio, иконки, словари. У нас модель описана в Zod и UI написан руками — отсюда разрыв в полноте.
- **Стрелка IDEF0 у BS — объект модели** `ActivityInputOrOutput` (16 хранимых полей): класс стрелки **на обоих концах**, сегменты, флаги «присоединён к фигуре» / «есть на диаграмме декомпозиции», «неопределённое начало/конец», сквозные объекты, связь/тип связи.
- **Концы стрелки**: `TypesOfArrowSegmentEnding` = Activity · ArrowSegment · **Border** (наша «Граница») · **OffPageReference** (междиаграммная ссылка) · **Tunnel**.
- **ICOM**: `ArrowClasses` = Input · Control · Output · Mechanism · Unknown (у нас 6 видов — нужно решение о маппинге).
- **Стили**: `EdgeStyles` (в т. ч. «Мост» — bridge на пересечениях), `DiagramDrawingModes` («Свободный»/«По сетке»), `ActivityCodeTypes` («Простой код»/«Полный код»/«Нет»); `SymbolStyleOfDiagramsStyle` хранит **«Мастер фигур MS Visio»**.
- **Портал** — ссылочная витрина: `objects`/`objectlinks` + отчёты (`reports`, `reportdata`, `avgreportdata`) + права (`rightsobjects`, `rightsreports`) + `users`, `files`, `forummessages`.

## Файлы

| Файл | Содержимое |
|---|---|
| `pm-bs-metamodel.json` | 671 класс BizArch (654 с русскими именами), свойства, варианты (2663) |
| `pm-bs-schema.json` | 481 таблица / 2081 хранимая колонка (класс → колонки с типами и перечислениями) |
| `pm-bs-enums.json`, `pm-bs-enums-ru.json` | 108 перечислений / 468 вариантов, 441 с русскими названиями |
| `pm-idef0-slice.txt` | IDEF0-срез: `ActivityInputOrOutput` (23 свойства), `FunctionalObjectOrGroup`, `DiagramStyle`, `SymbolStyleOfDiagramsStyle` |
| `pm-portal-schema.txt` | 22 таблицы портала (MySQL) |
| `pm-bs-inv.txt`, `pm-bs-db.txt`, `pm-bs-data.txt` | инвентарь установки, БД и сигнатуры `Data.bin`/`InstallData.bin` |
| `pm-rea-tw-sum.txt`, `pm-rea-bizarch-sum.txt`, `pm-rea-strings.txt` | метаданные аддона (194 типа) и клиента (1118 типов / 15 359 методов), кириллические имена |

Сырые evidence REA (`~5 МБ` и `~30 МБ`) в репозиторий не кладутся: они воспроизводятся командами ниже.

## Как воспроизвести

```powershell
# метамодель, перечисления, логическая схема (нужна установка BS)
node docs\bs6\tools\pm-bs-metamodel.mjs          # -> %TEMP%\pm-bs-metamodel.json
node docs\bs6\tools\pm-bs-enums.mjs              # -> %TEMP%\pm-bs-enums.json
node docs\bs6\tools\pm-bs-enums-ru.mjs           # + русские названия вариантов
node docs\bs6\tools\pm-bs-schema.mjs             # -> %TEMP%\pm-bs-schema.json
node docs\bs6\tools\pm-bs-enum.mjs <guid>        # варианты одного перечисления

# метаданные сборок (REA, движок rea-dotnet-static)
rea inspect-managed-members "C:\Program Files (x86)\STU-Soft\Business Studio 6\VSAddIn.ToolWindows.dll"
rea inspect-managed-members "C:\Program Files (x86)\STU-Soft\Business Studio 6\BizArch.Client.dll"
```

`rea analyze` для этих сборок не подходит: авто-выбор уходит в Ghidra/Hopper/IDA, а Ghidra на Windows не берёт managed-PE (`managed_target_unsupported`).

## Осталось (план)

1. Развернуть `ldstr`-литералы (`#US`-heap) — получить подписи команд/диалогов аддона и клиента.
2. Пространства имён и формы `BizArch.Client` (1118 типов), затем `AppPlatform.Client`.
3. Веб-клиент: `rea analyze-javascript-application` по `HtmlServerAssets\wwwroot`.
4. Свести в чек-лист паритета «BS ↔ наш редактор» по 16 полям стрелки и 481 таблице.
