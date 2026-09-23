/**
 * 生成一个够用的唯一 id。
 * 不引入 uuid 依赖：时间戳 + 随机后缀在单机 App 内已足够，且天然按时间有序。
 */
/**
 * @returns 形如 `lq3k9a-8f2b1c7d` 的新 id：前半是 36 进制的毫秒时间戳，
 *          后半是随机后缀。**同毫秒内不保证唯一**，但单机 App 的写入频率下够用。
 */
export function newId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${time}-${random}`;
}
