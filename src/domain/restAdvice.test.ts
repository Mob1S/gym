import { buildRestFeedback } from './restAdvice';

describe('buildRestFeedback', () => {
  it('少于 3 组时保持沉默', () => {
    expect(buildRestFeedback([5, 5], [90, 90])).toBeNull();
    expect(buildRestFeedback([5], [])).toBeNull();
    expect(buildRestFeedback([], [])).toBeNull();
  });

  it('次数没掉且休息正常时给正反馈', () => {
    const r = buildRestFeedback([5, 5, 5, 5], [90, 90, 90]);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('positive');
    expect(r!.drop).toBe(0);
    expect(r!.message).toContain('稳住');
  });

  it('末组超过首组（负 drop）同样算站住了', () => {
    const r = buildRestFeedback([3, 4, 5], [60, 60]);
    expect(r!.kind).toBe('positive');
    expect(r!.drop).toBe(-2);
  });

  it('没掉次数但平均休息超过 180 秒时建议加重量', () => {
    const r = buildRestFeedback([5, 5, 5], [200, 210, 190]);
    expect(r!.kind).toBe('add_weight');
    expect(r!.message).toContain('加重量');
    expect(r!.avgRest).toBe(200);
  });

  it('平均休息正好 180 秒时不算超长', () => {
    const r = buildRestFeedback([5, 5, 5], [180, 180, 180]);
    expect(r!.kind).toBe('positive');
  });

  it('休息数据全为空时按无休息数据处理，仍可给正反馈', () => {
    const r = buildRestFeedback([5, 5, 5], [null, null, null]);
    expect(r!.kind).toBe('positive');
    expect(r!.avgRest).toBeNull();
  });

  it('掉 1 次建议多歇 15 秒', () => {
    const r = buildRestFeedback([5, 5, 5, 4], [90, 90, 90]);
    expect(r!.kind).toBe('extend_15');
    expect(r!.drop).toBe(1);
    expect(r!.message).toContain('15 秒');
  });

  it('掉 2 次建议多歇 30 秒', () => {
    const r = buildRestFeedback([5, 5, 5, 3], [90, 90, 90]);
    expect(r!.kind).toBe('extend_30');
    expect(r!.drop).toBe(2);
    expect(r!.message).toContain('30 秒');
  });

  it('掉 3 次以上除建议延长外，还提示可能是重量偏大', () => {
    const r = buildRestFeedback([5, 5, 5, 2], [90, 90, 90]);
    expect(r!.kind).toBe('extend_30_check_weight');
    expect(r!.drop).toBe(3);
    expect(r!.message).toContain('重量偏大');
  });

  it('必须原样带回次数数组，供界面展示', () => {
    const r = buildRestFeedback([5, 5, 5, 3, 3], [90, 90, 90, 90]);
    expect(r!.reps).toEqual([5, 5, 5, 3, 3]);
  });

  it('只有 3 组且掉 2 次时也照常判断（3 组是可判断的下限）', () => {
    const r = buildRestFeedback([10, 8, 8], [60, 60]);
    expect(r!.kind).toBe('extend_30');
  });
});
