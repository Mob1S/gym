import { nextTemplateIndex } from './rotation';

/** 三套计划，下标即轮转顺序 */
const THREE = [{ id: 'push' }, { id: 'pull' }, { id: 'legs' }];

describe('nextTemplateIndex', () => {
  it('上一场是第二套时，轮到第三套', () => {
    expect(nextTemplateIndex(THREE, 'pull')).toBe(2);
  });

  it('上一场是最后一套时，绕回第一套', () => {
    // 这就是「循环」本身：不绕回去的话第四场会拿到 null 或者越界
    expect(nextTemplateIndex(THREE, 'legs')).toBe(0);
  });

  it('只有一套计划时永远是它', () => {
    expect(nextTemplateIndex([{ id: 'only' }], 'only')).toBe(0);
  });

  it('上一场不是用计划练的（null）时，从第一套开始', () => {
    expect(nextTemplateIndex(THREE, null)).toBe(0);
  });

  it('上一场用的计划已被删除时，从第一套开始', () => {
    // 计划被删掉之后，session.template_id 被置空、或者留着一个不在列表里的 id，
    // 两种都要能落地，不能算出一个 -1 让界面取到 templates[-1]
    expect(nextTemplateIndex(THREE, 'deleted-plan')).toBe(0);
  });

  it('一套计划都没有时返回 null', () => {
    // 老用户第一次升级上来就是这种状态，startNew 要据此退回「复制上一次」
    expect(nextTemplateIndex([], null)).toBeNull();
  });
});
