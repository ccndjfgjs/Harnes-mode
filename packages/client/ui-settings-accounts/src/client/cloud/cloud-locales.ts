/** `cloud` namespace dictionary: the cloud trigger source copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'crumbs.root': '云盘',
  'empty': '未连接云盘',
  'empty.hint': '设置 → 账户',
  'mega.notice': 'Mega 文件浏览即将到来',
  'mega.hint': '邮箱与密码已保存',
  'load.error': '加载失败',
  'file.truncated': '\n…（已截断）',
  'file.tooLarge': '文件过大，无法插入（{size} 字节）',
} satisfies Record<string, string>

/** The cloud namespace key union. */
export type CloudKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'crumbs.root': 'Clouds',
  'empty': 'No clouds connected',
  'empty.hint': 'Settings → Accounts',
  'mega.notice': 'Mega file browsing is coming soon',
  'mega.hint': 'Email and password are saved',
  'load.error': 'Load failed',
  'file.truncated': '\n…(truncated)',
  'file.tooLarge': 'File is too large to insert ({size} bytes)',
} satisfies Record<CloudKey, string>

/** Russian dictionary, checked complete against the zh key set. */
export const ru = {
  'crumbs.root': 'Облака',
  'empty': 'Нет подключённых облаков',
  'empty.hint': 'Настройки → Аккаунт',
  'mega.notice': 'Просмотр файлов Mega — скоро',
  'mega.hint': 'Почта и пароль сохранены',
  'load.error': 'Не удалось загрузить',
  'file.truncated': '\n…(обрезано)',
  'file.tooLarge': 'Файл слишком большой для вставки ({size} байт)',
} satisfies Record<CloudKey, string>
