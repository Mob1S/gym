import { parseWorkoutCsv } from './csv';

/** 把几行拼成一份 CSV 文本，行间统一用 \r\n（真实导出文件大多如此） */
function csv(rows: string[]): string {
  return rows.join('\r\n');
}

describe('CSV 解析：三种来源的列名', () => {
  it('Strong 的表头（Date / Workout Name / Exercise Name / Weight / Reps）', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Workout Name,Exercise Name,Set Order,Weight,Reps',
        '2024-01-15 09:30:00,推日,卧推,1,60,8',
        '2024-01-15 09:30:00,推日,卧推,2,60,7',
        '2024-01-15 09:30:00,推日,飞鸟,1,15,12',
      ]),
    );

    expect(result.skipped).toEqual([]);
    expect(result.detected.source).toBe('strong');
    expect(result.workouts).toHaveLength(1);
    const workout = result.workouts[0];
    expect(workout.name).toBe('推日');
    expect(workout.exercises.map((e) => e.name)).toEqual(['卧推', '飞鸟']);
    expect(workout.exercises[0].sets).toEqual([
      { weight: 60, reps: 8 },
      { weight: 60, reps: 7 },
    ]);
  });

  it('Hevy 的表头（title / start_time / exercise_title / weight_kg）', () => {
    const result = parseWorkoutCsv(
      csv([
        'title,start_time,exercise_title,set_index,weight_kg,reps',
        'Pull Day,2024-02-03 18:00:00,划船,0,70,8',
        'Pull Day,2024-02-03 18:00:00,划船,1,70,8',
      ]),
    );

    expect(result.detected.source).toBe('hevy');
    expect(result.workouts[0].name).toBe('Pull Day');
    expect(result.workouts[0].exercises[0].sets).toHaveLength(2);
  });

  it('训记的表头（日期 / 训练名称 / 动作名称 / 重量(kg) / 次数）', () => {
    const result = parseWorkoutCsv(
      csv([
        '日期,训练名称,动作名称,组序号,重量(kg),次数',
        '2024/3/5 19:00,腿日,深蹲,1,100,5',
      ]),
    );

    expect(result.detected.source).toBe('xunji');
    expect(result.workouts[0].exercises[0].name).toBe('深蹲');
    expect(result.workouts[0].exercises[0].sets).toEqual([{ weight: 100, reps: 5 }]);
  });
});

describe('CSV 解析：脏数据', () => {
  it('带 UTF-8 BOM 时首列名照样能匹配', () => {
    const result = parseWorkoutCsv(
      '\uFEFF' +
        csv([
          'Date,Exercise Name,Weight,Reps',
          '2024-01-15 09:30:00,卧推,60,8',
        ]),
    );
    // BOM 没被剥掉的话首列名是 '\uFEFFDate'，匹配不上 → 整个文件读不懂
    expect(result.workouts).toHaveLength(1);
  });

  it('字段里有逗号时靠引号保住', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,"卧推, 上斜",60,8',
      ]),
    );
    expect(result.workouts[0].exercises[0].name).toBe('卧推, 上斜');
  });

  it('字段里有转义的引号', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,"他说""上斜""卧推",60,8',
      ]),
    );
    expect(result.workouts[0].exercises[0].name).toBe('他说"上斜"卧推');
  });

  it('重量带单位 kg', () => {
    const result = parseWorkoutCsv(
      csv(['Date,Exercise Name,Weight,Reps', '2024-01-15 09:30:00,卧推,60kg,8']),
    );
    expect(result.workouts[0].exercises[0].sets[0].weight).toBe(60);
  });

  it('重量是磅时换算成公斤', () => {
    const result = parseWorkoutCsv(
      csv(['Date,Exercise Name,Weight,Reps', '2024-01-15 09:30:00,卧推,135 lb,8']),
    );
    // 135 lb = 61.23 kg，保留两位
    expect(result.workouts[0].exercises[0].sets[0].weight).toBeCloseTo(61.23, 2);
  });

  it('自重动作（BW / 空）记 0 kg，不算读不懂', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,引体向上,BW,8',
        '2024-01-15 09:30:00,俯卧撑,,20',
      ]),
    );
    expect(result.skipped).toEqual([]);
    expect(result.workouts[0].exercises[0].sets[0].weight).toBe(0);
    expect(result.workouts[0].exercises[1].sets[0].weight).toBe(0);
  });

  it('数出有几行是磅，供预览页写明换算过', () => {
    // 必须**算出来**而不是从 weight 反推：公斤与磅在解析结果里长得一模一样
    // （都已经是 kg 了），只有解析这一层知道哪几行原本是磅。
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,135 lb,8',
        '2024-01-15 09:35:00,深蹲,100,5',
        '2024-01-15 09:40:00,划船,80 lbs,10',
        '2024-01-15 09:45:00,引体向上,BW,8',
      ]),
    );

    expect(result.poundsConverted).toBe(2);
  });

  it('没有磅的时候计数是 0（不是 undefined）', () => {
    // 预览页要按这个数决定渲不渲染那一行说明，undefined 会让它渲染出「已把 undefined 行…」
    const result = parseWorkoutCsv(
      csv(['Date,Exercise Name,Weight,Reps', '2024-01-15 09:30:00,卧推,60,8']),
    );
    expect(result.poundsConverted).toBe(0);
  });

  it('只有日期没有时间时按当天 12:00 本地时间', () => {
    const result = parseWorkoutCsv(
      csv(['Date,Exercise Name,Weight,Reps', '2024-01-15,卧推,60,8']),
    );
    const date = new Date(result.workouts[0].startedAt);
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(15);
    // 零点最容易被时区处理推到前一天，所以刻意取正午
    expect(date.getHours()).toBe(12);
  });

  it('空行与重复表头行被跳过，且不计入 skipped', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '',
        '2024-01-15 09:30:00,卧推,60,8',
        'Date,Exercise Name,Weight,Reps',
        '   ',
      ]),
    );
    // 它们不是「读不懂」，报给用户只会让人以为文件有问题
    expect(result.skipped).toEqual([]);
    expect(result.workouts[0].exercises[0].sets).toHaveLength(1);
  });

  it('读不懂的行进 skipped，并带文件里的真实行号与原因', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,8',
        '15/1/24 上午9:30,深蹲,100,5',
      ]),
    );

    expect(result.workouts).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    // 第 1 行是表头，所以坏行是第 3 行 —— 用户要能对着表格直接找到它
    expect(result.skipped[0].line).toBe(3);
    expect(result.skipped[0].reason).toContain('日期');
  });

  it('次数不是数字时也进 skipped', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,八次',
      ]),
    );
    expect(result.workouts).toEqual([]);
    expect(result.skipped[0].line).toBe(2);
  });

  it('同一个动作在不同行出现时合并成一个动作、组按顺序累加', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,8',
        '2024-01-15 09:35:00,深蹲,100,5',
        '2024-01-15 09:40:00,卧推,65,6',
      ]),
    );

    const workout = result.workouts[0];
    // 三行属于同一场（同一天、时间挨着）—— 见下面那条测试的说明
    expect(workout.exercises.map((e) => e.name)).toEqual(['卧推', '深蹲']);
    expect(workout.exercises[0].sets).toEqual([
      { weight: 60, reps: 8 },
      { weight: 65, reps: 6 },
    ]);
  });

  it('不同日期的行拆成不同的训练', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,8',
        '2024-01-16 09:30:00,深蹲,100,5',
      ]),
    );

    expect(result.workouts).toHaveLength(2);
    // 越早的在前：历史列表与进步曲线都按时间排，导入的数组也按时间排
    expect(result.workouts[0].startedAt).toBeLessThan(result.workouts[1].startedAt);
    expect(result.workouts[0].exercises[0].name).toBe('卧推');
  });

  it('没有锻炼名那一列时，一场训练的名字是 null', () => {
    const result = parseWorkoutCsv(
      csv(['Date,Exercise Name,Weight,Reps', '2024-01-15 09:30:00,卧推,60,8']),
    );
    expect(result.workouts[0].name).toBeNull();
  });

  it('只有表头没有数据行时，workouts 是空的', () => {
    const result = parseWorkoutCsv('Date,Exercise Name,Weight,Reps');
    expect(result.workouts).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('完全认不出的文件（比如选错成别的 csv）返回空结果，不抛异常', () => {
    const result = parseWorkoutCsv(csv(['name,email', 'a,b']));
    expect(result.workouts).toEqual([]);
    // 这是「选错文件」的情形，界面据此不给「确认导入」按钮
    expect(result.detected.source).toBe('unknown');
  });

  it('finishedAt 默认比 startedAt 晚，且不早于它', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,8',
        '2024-01-15 11:00:00,飞鸟,15,12',
      ]),
    );
    const workout = result.workouts[0];
    // 一场训练的时长取「最后一行的时间 − 第一行的时间」，不足 1 分钟时兜底 1 分钟
    expect(workout.finishedAt).toBeGreaterThan(workout.startedAt);
  });
});
