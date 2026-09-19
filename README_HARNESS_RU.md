# DeepSeek Harness — установлено на Рабочий стол

Папка: `C:\Users\Dedy_Sher\Desktop\deepseek-harness`  
Источник: https://github.com/deepseek-ai/deepseek-harness

## Что установлено

1. **Официальный DeepSeek Harness (dsh)** — клон репозитория deepseek-ai/deepseek-harness
2. **Python SDK** `deepseek-harness-sdk 0.1.2a3` + `deepseek-harness-runtime-bin` (pip)
3. **Готовые скрипты** для быстрого старта

## Структура

```
deepseek-harness/
├── dsh_home/                # DSH_HOME — изолированное хранилище профилей
├── workspace/               # рабочая директория агента (твои файлы)
├── example_run.py           # главный пример SDK (рекомендуется)
├── simple_harness.py        # упрощенный харнес через OpenAI SDK
├── START_HARNESS.bat        # двойной клик для запуска (Windows)
├── START_HARNESS.ps1        # PowerShell вариант
├── .env.example             # шаблон для API ключа
└── python/sdk/README.md     # оригинальная дока SDK
```

## Быстрый старт (3 шага)

### 1. Получи API ключ DeepSeek
https://platform.deepseek.com/api-keys

### 2. Установи ключ

Вариант A — временно:
```powershell
$env:DEEPSEEK_API_KEY="sk-xxxxxxxx"
```

Вариант B — навсегда:
```powershell
setx DEEPSEEK_API_KEY "sk-xxxxxxxx"
```

Вариант C — через .env:
```powershell
copy .env.example .env
notepad .env
pip install python-dotenv
```

### 3. Запусти

Через Python SDK:
```powershell
python C:\Users\Dedy_Sher\Desktop\deepseek-harness\example_run.py
```
Или двойной клик: `START_HARNESS.bat`

Через упрощенный API:
```powershell
pip install openai
$env:DEEPSEEK_API_KEY="sk-xxx"
python C:\Users\Dedy_Sher\Desktop\deepseek-harness\simple_harness.py
```

Через Web UI:
```powershell
cd C:\Users\Dedy_Sher\Desktop\deepseek-harness
npx @deepseek-ai/dsh web
# откроется http://127.0.0.1:3080
```

## Использование в коде

```python
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    dsh_home=r"C:\Users\Dedy_Sher\Desktop\deepseek-harness\dsh_home",
    cwd=r"C:\Users\Dedy_Sher\Desktop\deepseek-harness\workspace",
    provider="deepseek-official",
    model="deepseek-chat",
) as harness:
    result = harness.run("Сделай рефакторинг файла main.py", session_id="sess-001")
    print(result.final_response)
```

## Важные нюансы

- DSH_HOME обязателен — SDK никогда не использует ~/.dsh автоматически
- cwd — папка где агент работает с файлами (создавай проекты в workspace/)
- session_id — переиспользуй для продолжения диалога
- Модели: deepseek-chat (V3), deepseek-reasoner (R1), deepseek-v4-flash
- pnpm нужен только для dsh plugin add

## Проверка установки

```powershell
python -c "import deepseek_harness; print('OK')"
$env:DSH_HOME="C:\Users\Dedy_Sher\Desktop\deepseek-harness\dsh_home"; dsh --help
```

## Ссылки

- Дока: https://deepseek-harness.github.io/deepseek-harness/
- Python SDK туториал: docs/user/guide/python-sdk.md
- Примеры: python/sdk/examples/README.md
