/** `settings.about` namespace dictionary: the About Settings page copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': '关于开发者',
  'title': '关于开发者',
  'author.title': '作者',
  'author.name': 'kz dark',
  'lead': '这个版本是开放的 DeepSeek Harness 的修改版：我想让 DeepSeek 更方便、让人人可用。',
  'diff.title': '与官方版的区别',
  'diff.body': '官方的 DeepSeek Harness 是面向开发者的开源工具：终端启动、英文与中文界面。这个修改版增加了：一键启动的窗口应用与安装包、俄语、语音控制、细化的无障碍设置、个性化外观，以及云端连接（Google Drive、Gmail、GitHub、Mega）。',
  'access.title': '最重要的是无障碍',
  'access.point.voice': '语音输入代替键盘：口述代替打字',
  'access.point.speech': '朗读回答与应用事件',
  'access.point.display': '大字体、高对比度、声音提醒',
  'status.title': '项目在持续开发',
  'status.body': '修改版还在不断完善：更新会带来新的功能。谢谢你的使用！',
} satisfies Record<string, string>

/** The about-settings namespace key union. */
export type AboutSettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'nav': 'About',
  'title': 'About the developer',
  'author.title': 'Author',
  'author.name': 'kz dark',
  'lead': 'This build is a mod of the open DeepSeek Harness: I want to make DeepSeek more convenient and accessible to everyone.',
  'diff.title': 'How it differs from the official build',
  'diff.body': 'The official DeepSeek Harness is an open tool for developers: terminal launch, English and Chinese UI. This mod adds: a one-click window app with an installer, Russian, voice control, dedicated accessibility settings, personal theming, and cloud connections (Google Drive, Gmail, GitHub, Mega).',
  'access.title': 'Accessibility first',
  'access.point.voice': 'Voice input instead of the keyboard: dictate instead of typing',
  'access.point.speech': 'Spoken answers and app events',
  'access.point.display': 'Large fonts, high contrast, sound notifications',
  'status.title': 'Actively developed',
  'status.body': 'The mod keeps improving: updates bring new features. Thanks for using it!',
} satisfies Record<AboutSettingsKey, string>

/** Russian dictionary, checked complete against the zh key set. */
export const ru = {
  'nav': 'О разработчике',
  'title': 'О разработчике',
  'author.title': 'Автор',
  'author.name': 'kz dark',
  'lead': 'Эта сборка — модификация открытого DeepSeek Harness: я хочу сделать DeepSeek удобнее и доступнее для всех.',
  'diff.title': 'Чем отличается от официального',
  'diff.body': 'Официальный DeepSeek Harness — открытый инструмент для разработчиков: запуск из терминала, интерфейс на английском и китайском. Модификация добавляет: оконное приложение с установщиком и запуском в один клик, русский язык, голосовое управление, отдельные настройки доступности, оформление под себя и подключение облаков (Google Drive, Gmail, GitHub, Mega).',
  'access.title': 'Главное — доступность',
  'access.point.voice': 'Голосовой ввод вместо клавиатуры: надиктовать вместо печати',
  'access.point.speech': 'Озвучка ответов и событий приложения',
  'access.point.display': 'Крупный шрифт, высокая контрастность, звуковые уведомления',
  'status.title': 'Проект живой',
  'status.body': 'Модификация дорабатывается: обновления приносят новые возможности. Спасибо, что пользуешься!',
} satisfies Record<AboutSettingsKey, string>
