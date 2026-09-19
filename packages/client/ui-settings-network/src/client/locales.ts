/** `settings.network` namespace dictionary: the network tunnel page copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': '网络',
  'title': '网络与代理',
  'description': '把 Harness 的请求经由你自己的服务器转发。程序在启动时读取一次代理设置，因此改动后需要重新启动程序才会生效。所有设置都保存在这台电脑上，不会外发。',
  'unavailable.title': '仅在桌面程序中可用',
  'unavailable.description': '你正在浏览器里打开这个界面，隧道由桌面程序负责，浏览器里无法使用。请从桌面程序打开这一页。',

  'tunnel.title': '隧道',
  'tunnel.description': '开启后，启动程序时会先拉起隧道，再把 Harness 的请求送进隧道。',
  'tunnel.on': '启动时自动连接',
  'tunnel.off': '不连接',
  'tunnel.socksPort': '本地 SOCKS 端口',
  'tunnel.httpPort': '本地 HTTP 端口',
  'tunnel.httpHint': 'Harness 只认识 HTTP 代理，所以真正生效的是这一项。SOCKS 端口留给隧道自检使用。',
  'tunnel.connect': '连接并检查',
  'tunnel.disconnect': '断开',
  'tunnel.idle': '未连接',
  'tunnel.connecting': '正在启动隧道…',
  'tunnel.testing': '正在检查隧道…',
  'tunnel.ok': '隧道可用：{target}，{ms} 毫秒',
  'tunnel.noBinary': '未找到 V2Ray 内核。请把 v2ray.exe 放到 installer/resources/v2ray 目录并重启程序。在此之前隧道无法工作，请在上方关闭它，以免影响启动。',
  'tunnel.noServer': '请先添加至少一个服务器。',

  'restart.title': '需要重新启动程序',
  'restart.description': '程序只在启动时读取一次代理设置。要让 Harness 真正走进隧道，请关闭并重新打开程序。',

  'servers.title': '服务器',
  'servers.description': '可以粘贴单条链接，也可以粘贴一整份列表；也支持用订阅链接一次载入多个服务器。',
  'servers.linkLabel': '服务器链接',
  'servers.linkPlaceholder': 'vless://… — 可以一次粘贴多条，每行一条',
  'servers.add': '加入列表',
  'servers.subLabel': '订阅链接（服务器列表）',
  'servers.subPlaceholder': 'https://…',
  'servers.load': '载入列表',
  'servers.empty': '列表还是空的：粘贴一条链接，或载入订阅列表。',
  'servers.selected': '正在使用',
  'servers.remove': '删除这个服务器',
  'servers.added': '已加入 {count} 个服务器',
  'servers.loaded': '已载入 {count} 个服务器',
  'error.unknown': '未知错误，请重试。',
} satisfies Record<string, string>

/** Dictionary key union for this namespace. */
export type NetworkSettingsKey = keyof typeof zh

/** Russian dictionary. */
export const ru = {
  'nav': 'Сеть',
  'title': 'Сеть и прокси',
  'description': 'Пустить запросы Harness через ваш собственный сервер. Настройки прокси программа читает один раз при запуске, поэтому после изменения приложение нужно перезапустить. Все настройки хранятся только на этом компьютере.',
  'unavailable.title': 'Доступно только в приложении',
  'unavailable.description': 'Вы открыли этот интерфейс в браузере. Туннелем управляет приложение, из браузера это недоступно. Откройте эту страницу в приложении.',

  'tunnel.title': 'Туннель',
  'tunnel.description': 'Когда включено, при запуске программы туннель поднимается первым, и только потом Harness получает адрес прокси.',
  'tunnel.on': 'Подключать при запуске',
  'tunnel.off': 'Не подключать',
  'tunnel.socksPort': 'Локальный SOCKS-порт',
  'tunnel.httpPort': 'Локальный HTTP-порт',
  'tunnel.httpHint': 'Harness понимает только HTTP-прокси, поэтому работает именно этот порт. SOCKS-порт остаётся для самопроверки туннеля.',
  'tunnel.connect': 'Подключить и проверить',
  'tunnel.disconnect': 'Отключить',
  'tunnel.idle': 'Не подключено',
  'tunnel.connecting': 'Запускаю туннель…',
  'tunnel.testing': 'Проверяю туннель…',
  'tunnel.ok': 'Туннель работает: {target}, {ms} мс',
  'tunnel.noBinary': 'Не найден V2Ray — движок туннеля. Положите файл v2ray.exe в папку installer/resources/v2ray и перезапустите приложение. Пока файла нет, туннель не заработает: выключите его выше, чтобы он не мешал запуску.',
  'tunnel.noServer': 'Сначала добавьте хотя бы один сервер.',

  'restart.title': 'Нужен перезапуск приложения',
  'restart.description': 'Программа читает настройки прокси один раз при запуске. Чтобы Harness действительно пошёл через туннель, закройте и откройте приложение заново.',

  'servers.title': 'Серверы',
  'servers.description': 'Можно вставить одну ссылку или сразу список. Ссылка на список серверов (подписка) загрузит все серверы за один раз.',
  'servers.linkLabel': 'Ссылка на сервер',
  'servers.linkPlaceholder': 'vless://… — можно вставить сразу несколько, каждая с новой строки',
  'servers.add': 'Добавить в список',
  'servers.subLabel': 'Ссылка на список серверов (подписка)',
  'servers.subPlaceholder': 'https://…',
  'servers.load': 'Загрузить список',
  'servers.empty': 'Список пуст: вставьте ссылку или загрузите подписку.',
  'servers.selected': 'Используется',
  'servers.remove': 'Удалить сервер',
  'servers.added': 'Добавлено серверов: {count}',
  'servers.loaded': 'Загружено серверов: {count}',

  'error.unknown': 'Что-то пошло не так. Попробуйте ещё раз.',
} satisfies Record<NetworkSettingsKey, string>

/** English dictionary. */
export const en = {
  'nav': 'Network',
  'title': 'Network and proxy',
  'description': 'Route Harness requests through your own server. The program reads the proxy settings once at startup, so a change takes effect after a restart. Everything is stored on this computer only.',
  'unavailable.title': 'Available in the desktop app only',
  'unavailable.description': 'This interface is open in a browser. The tunnel is owned by the desktop app, so it cannot be driven from here. Open this page inside the app.',

  'tunnel.title': 'Tunnel',
  'tunnel.description': 'When on, the tunnel is brought up before the Harness starts, and only then is the proxy address handed to it.',
  'tunnel.on': 'Connect at startup',
  'tunnel.off': 'Do not connect',
  'tunnel.socksPort': 'Local SOCKS port',
  'tunnel.httpPort': 'Local HTTP port',
  'tunnel.httpHint': 'Harness understands HTTP proxies only, so this is the port that actually carries traffic. The SOCKS port stays for the tunnel self-test.',
  'tunnel.connect': 'Connect and check',
  'tunnel.disconnect': 'Disconnect',
  'tunnel.idle': 'Not connected',
  'tunnel.connecting': 'Starting the tunnel…',
  'tunnel.testing': 'Checking the tunnel…',
  'tunnel.ok': 'Tunnel works: {target}, {ms} ms',
  'tunnel.noBinary': 'The V2Ray core is missing. Put v2ray.exe into installer/resources/v2ray and restart the app. Until it is there the tunnel cannot work: switch it off above so it does not block the launch.',
  'tunnel.noServer': 'Add at least one server first.',

  'restart.title': 'Restart the app',
  'restart.description': 'The program reads the proxy settings once at startup. For Harness to actually use the tunnel, close and reopen the app.',

  'servers.title': 'Servers',
  'servers.description': 'Paste a single link or a whole list. A subscription URL loads every server in one go.',
  'servers.linkLabel': 'Server link',
  'servers.linkPlaceholder': 'vless://… — paste several, one per line',
  'servers.add': 'Add to list',
  'servers.subLabel': 'Subscription URL (server list)',
  'servers.subPlaceholder': 'https://…',
  'servers.load': 'Load list',
  'servers.empty': 'The list is empty: paste a link or load a subscription.',
  'servers.selected': 'In use',
  'servers.remove': 'Remove this server',
  'servers.added': 'Added servers: {count}',
  'servers.loaded': 'Loaded servers: {count}',
  'error.unknown': 'Something went wrong. Please try again.',
} satisfies Record<NetworkSettingsKey, string>
