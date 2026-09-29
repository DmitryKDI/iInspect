/**
 * Токены визуального языка. Наследуются от платформы ЛОКИ и заменяются
 * одним файлом при переходе на официальный гайдлайн.
 */
export const theme = {
  color: {
    accent: '#5B5BD6',
    accentHover: '#4A4AC4',
    accentSoft: '#EEEEFB',
    surface: '#FFFFFF',
    surfaceMuted: '#F5F6F8',
    line: '#E3E5EA',
    ink: '#1F2330',
    inkMuted: '#5B6273',
    critical: '#C8324B',
    major: '#C77A16',
    minor: '#3E7C4F',
  },
  radius: '10px',
  severity: {
    critical: { label: 'Критическое', cls: 'bg-critical-soft text-critical border-critical/30' },
    major: { label: 'Существенное', cls: 'bg-major-soft text-major border-major/30' },
    minor: { label: 'Незначительное', cls: 'bg-minor-soft text-minor border-minor/30' },
  } as Record<string, { label: string; cls: string }>,
  transitions: {
    T1: 'ПД ред. N → ПД ред. N+1',
    T2: 'ПД → заключение экспертизы',
    T3: 'ПД → РД',
    T4: 'РД ред. N → РД ред. N+1',
    T5: 'РД → ИД',
    T6: 'ИД → ИД',
    T7: 'Состояние → нормативная база',
  } as Record<string, string>,
  stateKinds: {
    PD: 'Проектная документация',
    RD: 'Рабочая документация',
    EXPERTISE: 'Заключение экспертизы',
    AS_BUILT: 'Исполнительная документация',
    PERMIT: 'Разрешительная документация',
  } as Record<string, string>,
}
