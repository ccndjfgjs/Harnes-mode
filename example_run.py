# DeepSeek Harness - пример запуска Python SDK
# Документация SDK: python/sdk/README.md
# Запусти: python example_run.py

import os
import pathlib

# Укажи свой API ключ DeepSeek здесь или через переменную окружения DEEPSEEK_API_KEY
# Получить ключ: https://platform.deepseek.com/api-keys

API_KEY = os.getenv('DEEPSEEK_API_KEY', 'sk-...')  # <-- вставь свой ключ сюда или в .env
BASE_URL = os.getenv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')

from deepseek_harness import DeepSeekHarness

# Абсолютные пути - ОБЯЗАТЕЛЬНО для SDK (не использует ~/.dsh)
DSH_HOME = r'C:\Users\Dedy_Sher\Desktop\deepseek-harness\dsh_home'
WORKSPACE = r'C:\Users\Dedy_Sher\Desktop\deepseek-harness\workspace'

assert pathlib.Path(DSH_HOME).exists(), f'DSH_HOME не найден: {DSH_HOME}'

with DeepSeekHarness(
    dsh_home=DSH_HOME,
    cwd=WORKSPACE,
    provider='deepseek-official',
    model='deepseek-chat',
    # reasoning_effort='max',
    # max_tokens=4096,
    # api_key=API_KEY,  # можно передать явно, иначе возьмет из DEEPSEEK_API_KEY
    # base_url=BASE_URL,
) as harness:
    print('Harness запущен, профиль:', harness.profile if hasattr(harness, 'profile') else 'sdk')
    print('Отправляю запрос...')
    result = harness.run('Привет! Напиши хайку про код на Python.', session_id='example-001')
    print('--- FINAL RESPONSE ---')
    print(result.final_response)
    print('--- FINISH REASON ---')
    print(result.finish_reason)
    print('--- EVENTS count ---')
    print(len(result.events))
