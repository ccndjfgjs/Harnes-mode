#!/usr/bin/env python3
# DeepSeek Harness Launcher GUI - EXE для рабочего стола
# Позволяет ввести ключи/IP и запустить обычный харнес

import os
import sys
import pathlib
import subprocess
import threading
import webbrowser
from tkinter import *
from tkinter import ttk, messagebox, filedialog

# --- Пути ---
# Харнес установлен на рабочем столе
DEFAULT_BASE = pathlib.Path(r"C:\Users\Dedy_Sher\Desktop\deepseek-harness")
# Для exe: определяем где находится харнес
def get_base():
    # 1. Если запущен как exe на рабочем столе -> Desktop/deepseek-harness
    exe_dir = pathlib.Path(sys.executable).parent if getattr(sys, 'frozen', False) else pathlib.Path(__file__).parent
    candidates = [
        exe_dir / "deepseek-harness",  # exe на рабочем столе, харнес в папке рядом
        exe_dir,  # exe внутри папки харнеса
        DEFAULT_BASE,
        pathlib.Path.home() / "Desktop" / "deepseek-harness",
    ]
    for c in candidates:
        if (c / "example_run.py").exists() or (c / "python").exists():
            return c
    return DEFAULT_BASE

BASE = get_base()
DSH_HOME = BASE / "dsh_home"
WORKSPACE = BASE / "workspace"
ENV_FILE = BASE / ".env"
EXAMPLE_PY = BASE / "example_run.py"
SIMPLE_PY = BASE / "simple_harness.py"

APP_TITLE = "DeepSeek Harness — Launcher"

def load_env():
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
            line=line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k,v=line.split("=",1)
            env[k.strip()]=v.strip().strip('"').strip("'")
    # также из системных переменных
    for k in ["DEEPSEEK_API_KEY","DEEPSEEK_BASE_URL"]:
        if k in os.environ and k not in env:
            env[k]=os.environ[k]
    return env

def save_env(data):
    lines=[]
    if ENV_FILE.exists():
        # сохраняем комментарии
        for line in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.strip().startswith("#"):
                lines.append(line)
    for k,v in data.items():
        lines.append(f"{k}={v}")
    ENV_FILE.write_text("\n".join(lines)+"\n", encoding="utf-8")

class LauncherGUI:
    def __init__(self, root):
        self.root=root
        root.title(APP_TITLE)
        root.geometry("780x720")
        root.minsize(740, 680)
        try:
            root.iconbitmap("") # no icon
        except:
            pass
        # стиль
        style=ttk.Style()
        try:
            style.theme_use("vista")
        except:
            pass

        env=load_env()

        # === Заголовок ===
        header=ttk.Frame(root, padding=10)
        header.pack(fill=X)
        ttk.Label(header, text="DeepSeek Harness", font=("Segoe UI", 16, "bold")).pack(anchor=W)
        ttk.Label(header, text=f"Папка: {BASE} | DSH_HOME: {DSH_HOME}", font=("Segoe UI", 8), foreground="#666").pack(anchor=W)
        ttk.Separator(root).pack(fill=X, padx=10)

        # === Поля ввода ===
        form=ttk.Frame(root, padding=10)
        form.pack(fill=X)
        form.columnconfigure(1, weight=1)

        # API KEY
        ttk.Label(form, text="DEEPSEEK_API_KEY*:", font=("Segoe UI", 9, "bold")).grid(row=0, column=0, sticky=W, pady=5, padx=5)
        self.api_key_var=StringVar(value=env.get("DEEPSEEK_API_KEY",""))
        self.api_entry=ttk.Entry(form, textvariable=self.api_key_var, show="•", width=50, font=("Consolas", 10))
        self.api_entry.grid(row=0, column=1, sticky=EW, pady=5, padx=5)
        self.show_key_var=BooleanVar(value=False)
        def toggle_show():
            self.api_entry.config(show="" if self.show_key_var.get() else "•")
        ttk.Checkbutton(form, text="Показать", variable=self.show_key_var, command=toggle_show).grid(row=0, column=2, padx=5)

        # BASE URL / IP
        ttk.Label(form, text="DEEPSEEK_BASE_URL / IP:", font=("Segoe UI", 9)).grid(row=1, column=0, sticky=W, pady=5, padx=5)
        self.base_url_var=StringVar(value=env.get("DEEPSEEK_BASE_URL","https://api.deepseek.com"))
        base_row=ttk.Frame(form)
        base_row.grid(row=1, column=1, sticky=EW, pady=5, padx=5)
        base_row.columnconfigure(0, weight=1)
        self.base_entry=ttk.Entry(base_row, textvariable=self.base_url_var, font=("Consolas", 10))
        self.base_entry.pack(side=LEFT, fill=X, expand=True)
        ttk.Label(base_row, text=" ", width=1).pack(side=LEFT)
        # подсказки IP
        def set_url(v):
            self.base_url_var.set(v)
        ttk.Button(base_row, text="Офиц.", width=6, command=lambda: set_url("https://api.deepseek.com")).pack(side=LEFT, padx=2)
        ttk.Button(base_row, text="127.0.0.1", width=9, command=lambda: set_url("http://127.0.0.1:8000")).pack(side=LEFT, padx=2)

        # Модель
        ttk.Label(form, text="Модель:", font=("Segoe UI", 9)).grid(row=2, column=0, sticky=W, pady=5, padx=5)
        model_row=ttk.Frame(form)
        model_row.grid(row=2, column=1, sticky=EW, pady=5, padx=5)
        model_row.columnconfigure(0, weight=1)
        self.model_var=StringVar(value="deepseek-chat")
        self.model_combo=ttk.Combobox(model_row, textvariable=self.model_var, values=["deepseek-chat","deepseek-reasoner","deepseek-v4-flash","deepseek-v3","deepseek-r1"], state="readonly", width=22)
        self.model_combo.pack(side=LEFT)
        ttk.Label(model_row, text="  Workspace:").pack(side=LEFT, padx=5)
        self.workspace_var=StringVar(value=str(WORKSPACE))
        ttk.Entry(model_row, textvariable=self.workspace_var, font=("Consolas", 8), width=32).pack(side=LEFT, fill=X, expand=True, padx=5)
        ttk.Button(model_row, text="...", width=3, command=self.browse_workspace).pack(side=LEFT)

        # Промпт
        ttk.Label(form, text="Промпт для теста:", font=("Segoe UI", 9)).grid(row=3, column=0, sticky=NW, pady=5, padx=5)
        self.prompt_text=Text(form, height=3, font=("Consolas", 10), wrap=WORD, relief=SOLID, borderwidth=1)
        self.prompt_text.grid(row=3, column=1, sticky=EW, pady=5, padx=5)
        self.prompt_text.insert("1.0", "Привет! Напиши хайку про код на Python.")
        ttk.Label(form, text="").grid(row=3, column=2)

        # чекбокс сохранить
        self.save_var=BooleanVar(value=True)
        ttk.Checkbutton(form, text="Сохранить ключи в .env (BASE/.env)", variable=self.save_var).grid(row=4, column=1, sticky=W, padx=5)

        ttk.Separator(root).pack(fill=X, padx=10, pady=5)

        # === Кнопки запуска ===
        btn_frame=ttk.Frame(root, padding=10)
        btn_frame.pack(fill=X)
        # ряд 1
        r1=ttk.Frame(btn_frame)
        r1.pack(fill=X, pady=2)
        ttk.Button(r1, text="▶ Запустить обычный Харнес (SDK)", style="Accent.TButton", command=self.run_sdk).pack(side=LEFT, padx=5, fill=X, expand=True)
        ttk.Button(r1, text="▶ Simple Harness", command=self.run_simple).pack(side=LEFT, padx=5, fill=X, expand=True)
        ttk.Button(r1, text="🌐 Web UI (npx)", command=self.run_web).pack(side=LEFT, padx=5, fill=X, expand=True)

        r2=ttk.Frame(btn_frame)
        r2.pack(fill=X, pady=2)
        ttk.Button(r2, text="✓ Проверить ключ", command=self.check_key).pack(side=LEFT, padx=5, fill=X, expand=True)
        ttk.Button(r2, text="📁 Открыть workspace", command=self.open_workspace).pack(side=LEFT, padx=5, fill=X, expand=True)
        ttk.Button(r2, text="📁 Открыть папку харнеса", command=self.open_base).pack(side=LEFT, padx=5, fill=X, expand=True)
        ttk.Button(r2, text="💾 Сохранить .env", command=self.save_only).pack(side=LEFT, padx=5, fill=X, expand=True)

        # === Лог ===
        log_frame=ttk.Frame(root, padding=(10,0,10,10))
        log_frame.pack(fill=BOTH, expand=True)
        ttk.Label(log_frame, text="Лог:", font=("Segoe UI", 9, "bold")).pack(anchor=W)
        self.log_text=Text(log_frame, font=("Consolas", 9), wrap=WORD, bg="#0e0e0e", fg="#d4d4d4", insertbackground="white", relief=SOLID, borderwidth=1)
        self.log_text.pack(side=LEFT, fill=BOTH, expand=True)
        scrollbar=ttk.Scrollbar(log_frame, orient=VERTICAL, command=self.log_text.yview)
        scrollbar.pack(side=RIGHT, fill=Y)
        self.log_text.config(yscrollcommand=scrollbar.set)
        self.log_text.insert("1.0", f"=== {APP_TITLE} ===\n")
        self.log_text.insert(END, f"BASE: {BASE}\n")
        self.log_text.insert(END, f"DSH_HOME: {DSH_HOME}\n")
        self.log_text.insert(END, f"ENV_FILE: {ENV_FILE} ({'найден' if ENV_FILE.exists() else 'не найден'})\n")
        self.log_text.insert(END, f"Готов. Введи DEEPSEEK_API_KEY и нажми 'Запустить обычный Харнес'.\n")
        self.log_text.insert(END, f"Получить ключ: https://platform.deepseek.com/api-keys\n\n")
        # кнопки очистки/копирования
        log_btns=ttk.Frame(root, padding=(10,0,10,10))
        log_btns.pack(fill=X)
        ttk.Button(log_btns, text="Очистить лог", command=lambda: self.log_text.delete("1.0", END)).pack(side=LEFT, padx=5)
        ttk.Button(log_btns, text="Копировать лог", command=self.copy_log).pack(side=LEFT, padx=5)
        ttk.Button(log_btns, text="Инструкция", command=self.show_help).pack(side=RIGHT, padx=5)

        # статус бар
        self.status_var=StringVar(value="Готов")
        status=ttk.Label(root, textvariable=self.status_var, anchor=W, relief=SUNKEN, padding=5, font=("Segoe UI", 8))
        status.pack(side=BOTTOM, fill=X)

        # проверка наличия файлов
        self.check_files()

    def log(self, msg):
        self.log_text.insert(END, msg + "\n")
        self.log_text.see(END)
        self.root.update_idletasks()

    def check_files(self):
        if not EXAMPLE_PY.exists():
            self.log(f"[WARN] Не найден {EXAMPLE_PY}")
        if not DSH_HOME.exists():
            self.log(f"[WARN] DSH_HOME не найден, будет создан при запуске: {DSH_HOME}")
        if not WORKSPACE.exists():
            try:
                WORKSPACE.mkdir(parents=True, exist_ok=True)
                self.log(f"[OK] Создан workspace: {WORKSPACE}")
            except Exception as e:
                self.log(f"[ERR] Не удалось создать workspace: {e}")

    def get_env_for_run(self):
        env=os.environ.copy()
        api=self.api_key_var.get().strip()
        base_url=self.base_url_var.get().strip()
        if api:
            env["DEEPSEEK_API_KEY"]=api
        if base_url:
            env["DEEPSEEK_BASE_URL"]=base_url
        env["DSH_HOME"]=str(DSH_HOME)
        # workspace через cwd в example_run, но также передаем
        return env

    def save_only(self):
        data={}
        api=self.api_key_var.get().strip()
        base_url=self.base_url_var.get().strip()
        if api:
            data["DEEPSEEK_API_KEY"]=api
        if base_url:
            data["DEEPSEEK_BASE_URL"]=base_url
        if not data:
            messagebox.showwarning("Сохранение", "Нечего сохранять — поля пустые")
            return
        save_env(data)
        self.log(f"[OK] Сохранено в {ENV_FILE}: {list(data.keys())}")
        self.status_var.set(f"Сохранено {ENV_FILE}")
        messagebox.showinfo("Сохранено", f"Сохранено в:\n{ENV_FILE}")

    def browse_workspace(self):
        d=filedialog.askdirectory(initialdir=self.workspace_var.get(), title="Выбери workspace")
        if d:
            self.workspace_var.set(d)

    def open_workspace(self):
        p=pathlib.Path(self.workspace_var.get())
        if not p.exists():
            p.mkdir(parents=True, exist_ok=True)
        try:
            os.startfile(str(p))
        except:
            webbrowser.open(str(p))
        self.log(f"[OK] Открыт workspace: {p}")

    def open_base(self):
        try:
            os.startfile(str(BASE))
        except:
            webbrowser.open(str(BASE))
        self.log(f"[OK] Открыта папка харнеса: {BASE}")

    def copy_log(self):
        txt=self.log_text.get("1.0", END)
        self.root.clipboard_clear()
        self.root.clipboard_append(txt)
        self.log("[OK] Лог скопирован в буфер")

    def show_help(self):
        help_text = (
            "DeepSeek Harness Launcher — инструкция:\n\n"
            "1. Получи ключ на https://platform.deepseek.com/api-keys\n"
            "2. Вставь DEEPSEEK_API_KEY (sk-...)\n"
            "3. Укажи DEEPSEEK_BASE_URL — по умолчанию https://api.deepseek.com\n"
            "   Можно указать IP прокси, напр. http://127.0.0.1:8000 или http://192.168.1.10:3000\n"
            "4. Выбери модель: deepseek-chat (V3), deepseek-reasoner (R1), deepseek-v4-flash\n"
            "5. Нажми 'Запустить обычный Харнес (SDK)' — запустится example_run.py через DeepSeekHarness\n"
            "   или 'Simple Harness' — напрямую через OpenAI API\n"
            "   или 'Web UI' — npx @deepseek-ai/dsh web на http://127.0.0.1:3080\n\n"
            f"BASE: {BASE}\n"
            f"DSH_HOME: {DSH_HOME}\n"
            f"WORKSPACE: {self.workspace_var.get()}\n"
            "Все ключи можно сохранить в .env, галочка 'Сохранить ключи в .env'"
        )
        messagebox.showinfo("Инструкция", help_text)

    def validate(self):
        api=self.api_key_var.get().strip()
        if not api or api in ["sk-...", "sk-REPLACE_WITH_YOUR_KEY", ""]:
            messagebox.showwarning("Проверка", "Введи DEEPSEEK_API_KEY!\nПолучи на https://platform.deepseek.com/api-keys")
            return False
        if not self.base_url_var.get().strip():
            messagebox.showwarning("Проверка", "Укажи DEEPSEEK_BASE_URL (напр. https://api.deepseek.com)")
            return False
        return True

    def run_in_thread(self, target):
        # блокируем кнопки на время
        self.status_var.set("Выполняется...")
        def wrapper():
            try:
                target()
            except Exception as e:
                self.log(f"[ERR] {e}")
                import traceback
                self.log(traceback.format_exc())
            finally:
                self.status_var.set("Готов")
        threading.Thread(target=wrapper, daemon=True).start()

    def run_sdk(self):
        if not self.validate():
            return
        if self.save_var.get():
            self.save_only()
        self.log("=== Запуск обычного Харнеса (SDK) ===")
        self.log(f"Модель: {self.model_var.get()}")
        self.log(f"DSH_HOME: {DSH_HOME}")
        self.log(f"WORKSPACE: {self.workspace_var.get()}")
        self.log(f"BASE_URL: {self.base_url_var.get()}")
        self.log(f"Промпт: {self.prompt_text.get('1.0', END).strip()}")
        self.log("---")
        def task():
            env=self.get_env_for_run()
            workspace=str(pathlib.Path(self.workspace_var.get()))
            prompt=self.prompt_text.get("1.0", END).strip()
            model=self.model_var.get().strip()
            # Создаем временный скрипт запуска с нужной моделью/промптом
            tmp_script = BASE / "_launcher_run_tmp.py"
            tmp_script.write_text(f'''
import os, pathlib
from deepseek_harness import DeepSeekHarness
DSH_HOME=r"{DSH_HOME}"
WORKSPACE=r"{workspace}"
PROMPT={repr(prompt)}
MODEL={repr(model)}
print("Harness:", DSH_HOME, WORKSPACE, MODEL)
with DeepSeekHarness(dsh_home=DSH_HOME, cwd=WORKSPACE, provider="deepseek-official", model=MODEL) as harness:
    result=harness.run(PROMPT, session_id="launcher-001")
    print("=== FINAL RESPONSE ===")
    print(result.final_response)
    print("=== FINISH REASON ===")
    print(result.finish_reason)
    print("=== EVENTS ===")
    print(len(result.events))
''', encoding="utf-8")
            # Запуск через subprocess чтобы логи шли сюда
            cmd=[sys.executable, str(tmp_script)]
            self.log(f"$ {' '.join(cmd)}")
            proc=subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1, cwd=str(BASE))
            for line in proc.stdout:
                self.log(line.rstrip())
            proc.wait()
            self.log(f"[EXIT CODE {proc.returncode}]")
            if proc.returncode==0:
                self.log("[OK] Харнес завершил успешно")
            else:
                self.log("[WARN] Проверь API ключ/IP и интернет")
        self.run_in_thread(task)

    def run_simple(self):
        if not self.validate():
            return
        if self.save_var.get():
            self.save_only()
        self.log("=== Запуск Simple Harness (OpenAI API) ===")
        def task():
            env=self.get_env_for_run()
            prompt=self.prompt_text.get("1.0", END).strip()
            model=self.model_var.get().strip()
            tmp = BASE / "_launcher_simple_tmp.py"
            tmp.write_text(f'''
import os
from openai import OpenAI
client=OpenAI(api_key=os.getenv("DEEPSEEK_API_KEY"), base_url=os.getenv("DEEPSEEK_BASE_URL","https://api.deepseek.com"))
print("Model:", {repr(model)})
resp=client.chat.completions.create(model={repr(model)}, messages=[{{"role":"user","content":{repr(prompt)}}}])
print("=== RESPONSE ===")
print(resp.choices[0].message.content)
print("=== USAGE ===")
print(resp.usage)
rc=getattr(resp.choices[0].message, "reasoning_content", None)
if rc:
    print("=== REASONING ===")
    print(rc[:2000])
''', encoding="utf-8")
            cmd=[sys.executable, str(tmp)]
            self.log(f"$ {' '.join(cmd)}")
            proc=subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1, cwd=str(BASE))
            for line in proc.stdout:
                self.log(line.rstrip())
            proc.wait()
            self.log(f"[EXIT CODE {proc.returncode}]")
        self.run_in_thread(task)

    def run_web(self):
        self.log("=== Запуск Web UI (npx @deepseek-ai/dsh web) ===")
        self.log("Откроется http://127.0.0.1:3080")
        self.log("Для остановки закрой окно терминала или нажми Ctrl+C в логе")
        def task():
            env=self.get_env_for_run()
            # Пробуем npx
            cmd=["npx", "@deepseek-ai/dsh", "web", "--no-open"]
            # Windows: npx.cmd
            import shutil
            npx=shutil.which("npx")
            if npx:
                cmd=[npx, "@deepseek-ai/dsh", "web", "--no-open"]
            self.log(f"$ {' '.join(cmd)} (cwd={BASE})")
            proc=subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1, cwd=str(BASE))
            for line in proc.stdout:
                self.log(line.rstrip())
                if "127.0.0.1" in line or "3080" in line or "localhost" in line:
                    self.log("[HINT] Открой браузер: http://127.0.0.1:3080")
            proc.wait()
            self.log(f"[EXIT CODE {proc.returncode}]")
        self.run_in_thread(task)

    def check_key(self):
        if not self.validate():
            return
        self.log("=== Проверка ключа ===")
        def task():
            env=self.get_env_for_run()
            tmp=BASE / "_launcher_check_tmp.py"
            tmp.write_text('''
import os
from openai import OpenAI
k=os.getenv("DEEPSEEK_API_KEY","")
print(f"Key: {k[:8]}...{k[-4:] if len(k)>8 else ''} len={len(k)}")
print(f"Base URL: {os.getenv('DEEPSEEK_BASE_URL')}")
client=OpenAI(api_key=k, base_url=os.getenv("DEEPSEEK_BASE_URL","https://api.deepseek.com"))
try:
    models=client.models.list()
    print("[OK] Ключ валиден! Доступные модели:")
    for m in models.data[:10]:
        print(" -", m.id)
    # тест чата
    r=client.chat.completions.create(model="deepseek-chat", messages=[{"role":"user","content":"hi"}], max_tokens=10)
    print("[OK] Чат тест успешен:", r.choices[0].message.content[:100])
except Exception as e:
    print("[ERR] Ошибка проверки:", e)
    import traceback; traceback.print_exc()
''', encoding="utf-8")
            cmd=[sys.executable, str(tmp)]
            proc=subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1, cwd=str(BASE))
            for line in proc.stdout:
                self.log(line.rstrip())
            proc.wait()
            self.log(f"[EXIT CODE {proc.returncode}]")
        self.run_in_thread(task)

if __name__=="__main__":
    root=Tk()
    app=LauncherGUI(root)
    root.mainloop()
