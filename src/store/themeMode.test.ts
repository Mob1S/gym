import { toThemeOverride } from './themeMode';

/**
 * `toThemeOverride` 是「设置」和「配色」两套词汇的唯一接触点。
 *
 * 单独测它是因为弄错了最难查：界面不报错，只是「选了浅色却还是深色」。
 * 三态（system/light/dark）到两态加 null 的映射错了，症状就是这样。
 */
describe('toThemeOverride', () => {
  it('system 映射成 null（表示跟随系统，由 useColorScheme 决定）', () => {
    expect(toThemeOverride('system')).toBeNull();
  });

  it('light 原样透传', () => {
    expect(toThemeOverride('light')).toBe('light');
  });

  it('dark 原样透传', () => {
    expect(toThemeOverride('dark')).toBe('dark');
  });

  it('只有 system 会变成 null —— 不能把 light 也当成「没选」', () => {
    // 反例保护：如果实现写成 `mode === 'system' || mode === 'light'` 之类，
    // 选浅色就退化成跟随系统，在深色手机上表现为「选浅色没反应」
    expect(toThemeOverride('light')).not.toBeNull();
    expect(toThemeOverride('dark')).not.toBeNull();
  });
});
