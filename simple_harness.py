# Simple DeepSeek Harness (fallback без Cordis)
# Работает через OpenAI-совместимый API DeepSeek
# pip install openai python-dotenv
# DEEPSEEK_API_KEY обязателен

import os
from openai import OpenAI

api_key = os.getenv('DEEPSEEK_API_KEY') or 'sk-...'  # вставь ключ
if api_key == 'sk-...' or not api_key:
    print('УСТАНОВИ DEEPSEEK_API_KEY! Получи на https://platform.deepseek.com/api-keys')
    print('Пример: set DEEPSEEK_API_KEY=sk-xxx && python simple_harness.py')

client = OpenAI(
    api_key=api_key,
    base_url=os.getenv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')
)

MODEL = 'deepseek-chat'

def chat(messages, model=MODEL, stream=False, **kwargs):
    kwargs.setdefault('temperature', 1.0)
    if stream:
        resp = client.chat.completions.create(model=model, messages=messages, stream=True, **kwargs)
        full = ''
        for chunk in resp:
            delta = chunk.choices[0].delta.content or ''
            print(delta, end='', flush=True)
            full += delta
        print()
        return full
    else:
        resp = client.chat.completions.create(model=model, messages=messages, **kwargs)
        msg = resp.choices[0].message.content
        reasoning = getattr(resp.choices[0].message, 'reasoning_content', None)
        if reasoning:
            print('[REASONING]:', reasoning[:500], '...')
        print('[RESPONSE]:', msg)
        print('[USAGE]:', resp.usage)
        return msg

if __name__ == '__main__':
    print('=== DeepSeek Simple Harness ===')
    try:
        chat([{'role': 'user', 'content': 'Привет! Кто ты?'}])
        print()
        print('=== STREAM ===')
        chat([{'role': 'user', 'content': 'Напиши короткую сказку про робота'}], stream=True)
    except Exception as e:
        print('Ошибка (проверь API ключ):', e)
