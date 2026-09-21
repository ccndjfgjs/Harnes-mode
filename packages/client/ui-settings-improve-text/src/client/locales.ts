/** `settings.improve-text` namespace dictionary: the Improve-text page copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': '改进文本',
  'title': '改进文本',
  'description': '这里是聊天窗口“改进文本”按钮的设置：语音播报和支持的模型。',
  'scan.title': '检查模型',
  'scan.button': '检查模型',
  'scan.scanning': '检查中…',
  'loadFailed': '无法读取服务商列表',
  'retry': '重试',
  'list.label': '模型',
  'list.placeholder': '打开查看',
  'list.hint': '此列表仅供查看：★ 可用，✉ 仅批量，? 缺少密钥。此处不能选择。',
  'list.empty': '列表为空 — 请点击“检查模型”。',
  'voice.title': '语音',
  'voice.label': '语音播报按钮结果',
  'voice.readAloud': '朗读改进后的文本',
  'voice.hint': '成功和失败都会播报，使用语音设置里的服务。全局语音关闭时保持安静。',
} as const

/** Russian dictionary, checked complete against the zh key set. */
export const ru = {
  'nav': 'Улучшить текст',
  'title': 'Улучшить текст',
  'description': 'Здесь живёт кнопка «Улучшить текст» из окна чата: голосовые объявления результата и модели, которые её понимают.',
  'scan.title': 'Проверка моделей',
  'scan.button': 'Проверить модели',
  'scan.scanning': 'Проверяю…',
  'loadFailed': 'Не удалось получить список провайдеров',
  'retry': 'Повторить',
  'list.label': 'Модели',
  'list.placeholder': 'Открыть для просмотра',
  'list.hint': 'Список только показывает: ★ — работает с кнопкой, ✉ — только почта, ? — нет ключа. Выбрать здесь ничего нельзя.',
  'list.empty': 'Список пуст — нажми «Проверить модели».',
  'voice.title': 'Озвучка',
  'voice.label': 'Озвучивать результат кнопки',
  'voice.readAloud': 'Зачитывать улучшенный текст',
  'voice.hint': 'Говорит и удачу, и неудачу голосом из голосовых настроек. Молчит, если общий голос выключен.',
} as const

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'nav': 'Improve text',
  'title': 'Improve text',
  'description': 'Home of the chat "Improve text" button: voice announcements and supported models.',
  'scan.title': 'Check models',
  'scan.button': 'Check models',
  'scan.scanning': 'Checking…',
  'loadFailed': 'Could not load the provider list',
  'retry': 'Retry',
  'list.label': 'Models',
  'list.placeholder': 'Open to view',
  'list.hint': 'This list is display-only: ★ works with the button, ✉ batch only, ? no key. Nothing can be selected here.',
  'list.empty': 'The list is empty — press "Check models".',
  'voice.title': 'Voice',
  'voice.label': 'Announce the button result aloud',
  'voice.readAloud': 'Read the improved text aloud',
  'voice.hint': 'Announces success and failure through the voice service. Silent when the global voice is off.',
} as const

/** Every key of the Improve-text namespace. */
export type ImproveTextKey = keyof typeof zh
