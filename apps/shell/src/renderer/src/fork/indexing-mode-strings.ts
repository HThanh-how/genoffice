import type { Lang } from '@genoffice/i18n'
import type {
  IndexingEffectiveState,
  IndexingMode,
  IndexingPauseReason,
} from '../../../shared/fork/indexing-mode'

/**
 * Strings for the indexing-effort setting and the live status lines. Fork-owned so the shared
 * strings.ts stays untouched. `zh` defines the key set; languages without a table fall back to
 * English.
 */
const zh = {
  title: '索引速度',
  desc: '后台为文档建立索引时可使用多少电脑资源。GenOffice 始终优先保证你当前的操作流畅。',
  modeLabel: '索引速度',
  light: '轻柔',
  lightDesc: '只用一个线程，占用很少，速度最慢。',
  balanced: '均衡',
  balancedDesc: '你工作时保持轻量，电脑空闲且已接通电源时加快。',
  fast: '快速',
  fastDesc: '电脑空闲且已接通电源时使用更多核心，但绝不超过一半。',
  pauseBattery: '使用电池时暂停',
  pauseBatteryDesc: '使用电池时只用一个线程；电量低于 30%、开启节电模式或锁屏时完全暂停。',
  statusChecking: '正在检查电脑状态…',
  statusIdle: '正在快速运行（{threads}），因为电脑空闲且已接通电源',
  statusActive: '正在轻量运行（{threads}），不影响你的操作',
  statusLight: '正在安静运行，只用 1 个线程',
  statusBattery: '正在使用电池：只用 1 个线程以节省电量',
  statusPaused: '已暂停：{why}',
  whyBattery: '正在使用电池',
  whyLowBattery: '电量过低',
  whyBatterySaver: '已开启节电模式',
  whyLocked: '屏幕已锁定',
  whyLowMemory: '可用内存不足',
  whyThermal: '电脑过热',
  whyUser: '你已关闭文档记忆',
  whySuspended: '电脑已休眠',
  popupIdle: '快速运行中（{threads}）',
  popupActive: '轻量运行中（{threads}）',
  popupLight: '安静运行中（{threads}）',
  popupBattery: '节电运行中（{threads}）',
  popupPaused: '已暂停：{why}',
  threadOne: '{n} 个线程',
  threadMany: '{n} 个线程',
}

type Dict = Record<keyof typeof zh, string>

const en = {
  title: 'Indexing speed',
  desc: 'How much of your computer background indexing may use. GenOffice always gives way to what you are doing.',
  modeLabel: 'Indexing speed',
  light: 'Light',
  lightDesc: 'One thread and a small share of a core. Quietest, slowest.',
  balanced: 'Balanced',
  balancedDesc: 'Gentle while you work, faster when the computer is idle and plugged in.',
  fast: 'Fast',
  fastDesc: 'Uses more cores when idle and plugged in, but never more than half of them.',
  pauseBattery: 'Pause on battery',
  pauseBatteryDesc:
    'On battery, indexing runs on one thread and stops completely below 30%, in battery saver, or when the screen is locked.',
  statusChecking: 'Checking the computer…',
  statusIdle: 'Running fast ({threads}) because the computer is idle and plugged in',
  statusActive: 'Running gently ({threads}) so your work stays smooth',
  statusLight: 'Running quietly on 1 thread',
  statusBattery: 'On battery: running on 1 thread to save power',
  statusPaused: 'Paused: {why}',
  whyBattery: 'on battery',
  whyLowBattery: 'battery is low',
  whyBatterySaver: 'battery saver is on',
  whyLocked: 'the screen is locked',
  whyLowMemory: 'the computer is low on memory',
  whyThermal: 'the computer is too hot',
  whyUser: 'document memory is switched off',
  whySuspended: 'the computer is asleep',
  popupIdle: 'Running fast ({threads})',
  popupActive: 'Running gently ({threads})',
  popupLight: 'Running quietly ({threads})',
  popupBattery: 'Saving battery ({threads})',
  popupPaused: 'Paused: {why}',
  threadOne: '{n} thread',
  threadMany: '{n} threads',
} satisfies Dict

const vi = {
  title: 'Tốc độ lập chỉ mục',
  desc: 'Mức tài nguyên máy tính mà việc lập chỉ mục chạy nền được dùng. GenOffice luôn nhường chỗ cho việc bạn đang làm.',
  modeLabel: 'Tốc độ lập chỉ mục',
  light: 'Nhẹ',
  lightDesc: 'Chỉ một luồng và rất ít tài nguyên. Êm nhất nhưng chậm nhất.',
  balanced: 'Cân bằng',
  balancedDesc: 'Nhẹ nhàng khi bạn đang làm việc, nhanh hơn khi máy rảnh và đang cắm điện.',
  fast: 'Nhanh',
  fastDesc: 'Dùng nhiều lõi hơn khi máy rảnh và cắm điện, nhưng không bao giờ quá một nửa số lõi.',
  pauseBattery: 'Tạm dừng khi dùng pin',
  pauseBatteryDesc:
    'Khi dùng pin, chỉ chạy một luồng và dừng hẳn nếu pin dưới 30%, đang bật tiết kiệm pin hoặc đã khóa màn hình.',
  statusChecking: 'Đang kiểm tra tình trạng máy…',
  statusIdle: 'Đang chạy nhanh ({threads}) vì máy đang rảnh và cắm điện',
  statusActive: 'Đang chạy nhẹ nhàng ({threads}) để công việc của bạn vẫn mượt',
  statusLight: 'Đang chạy êm, chỉ dùng 1 luồng',
  statusBattery: 'Đang dùng pin: chỉ chạy 1 luồng để tiết kiệm điện',
  statusPaused: 'Tạm dừng: {why}',
  whyBattery: 'đang dùng pin',
  whyLowBattery: 'pin sắp hết',
  whyBatterySaver: 'đang bật chế độ tiết kiệm pin',
  whyLocked: 'màn hình đang khóa',
  whyLowMemory: 'máy sắp hết bộ nhớ trống',
  whyThermal: 'máy đang quá nóng',
  whyUser: 'bạn đã tắt bộ nhớ tài liệu',
  whySuspended: 'máy tính đang tạm nghỉ',
  popupIdle: 'Đang chạy nhanh ({threads})',
  popupActive: 'Đang chạy nhẹ ({threads})',
  popupLight: 'Đang chạy êm ({threads})',
  popupBattery: 'Đang tiết kiệm pin ({threads})',
  popupPaused: 'Tạm dừng: {why}',
  threadOne: '{n} luồng',
  threadMany: '{n} luồng',
} satisfies Dict

const tables: Partial<Record<Lang, Dict>> = { zh, en, vi }

export type IndexingStringKey = keyof Dict

export function indexingString(
  lang: Lang,
  key: IndexingStringKey,
  params?: Record<string, string | number>,
): string {
  const source = (tables[lang] ?? en)[key]
  return source.replace(/\{(\w+)\}/g, (match, name: string) =>
    params?.[name] == null ? match : String(params[name]),
  )
}

const MODE_KEYS: Record<IndexingMode, { label: IndexingStringKey; desc: IndexingStringKey }> = {
  light: { label: 'light', desc: 'lightDesc' },
  balanced: { label: 'balanced', desc: 'balancedDesc' },
  fast: { label: 'fast', desc: 'fastDesc' },
}
export const indexingModeKeys = (mode: IndexingMode) => MODE_KEYS[mode]

const WHY_KEYS: Record<IndexingPauseReason, IndexingStringKey> = {
  battery: 'whyBattery',
  'low-battery': 'whyLowBattery',
  'battery-saver': 'whyBatterySaver',
  locked: 'whyLocked',
  'low-memory': 'whyLowMemory',
  thermal: 'whyThermal',
  user: 'whyUser',
  suspended: 'whySuspended',
}

/**
 * One-line description of the effective state. `compact` gives the short form used in the
 * document-index popup; the Settings status line spells out the reason.
 */
export function indexingStateLine(
  lang: Lang,
  state: IndexingEffectiveState,
  compact = false,
): string {
  const threads = indexingString(lang, state.threads === 1 ? 'threadOne' : 'threadMany', {
    n: state.threads,
  })
  if (state.paused) {
    const why = indexingString(lang, WHY_KEYS[state.pauseReason ?? 'battery'])
    return indexingString(lang, compact ? 'popupPaused' : 'statusPaused', { why })
  }
  const kind =
    state.tier === 'idle' || state.tier === 'active' || state.tier === 'battery'
      ? state.tier
      : 'light'
  if (compact) {
    const key = {
      idle: 'popupIdle',
      active: 'popupActive',
      battery: 'popupBattery',
      light: 'popupLight',
    } as const
    return indexingString(lang, key[kind], { threads })
  }
  const key = {
    idle: 'statusIdle',
    active: 'statusActive',
    battery: 'statusBattery',
    light: 'statusLight',
  } as const
  return indexingString(lang, key[kind], { threads })
}
