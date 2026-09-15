/**
 * 生成一个够用的唯一 id。
 * 不引入 uuid 依赖：时间戳 + 随机后缀在单机 App 内已足够，且天然按时间有序。
 */
export function newId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${time}-${random}`;
}
