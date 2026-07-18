// 任务细节补全：当 AI 只返回任务骨架（标题/描述/分钟数）时，
// 由后端生成结构化的执行步骤（微动作、自检、卡点解法），
// 保证默认拆解和"调整日程"重排后的任务具体化程度一致。

export type FallbackStep = {
  action: string;
  goal: string;
  minutes: number;
  guide: string;
  microActions: Array<{
    text: string;
    material?: string;
    sourceRef?: string;
    timeLimit?: string;
  }>;
  checkCriteria: string;
  blockers: Array<{ problem: string; solution: string }>;
};

export function buildFallbackStepsForTask(
  title: string,
  subject: string | undefined,
  minutes: number,
  checkCriteria: string,
): FallbackStep[] {
  const stepMinutes = Math.max(15, Math.min(25, Math.round(minutes / 2)));
  const moduleName = subject || "当前任务";
  return [
    {
      action: `准备${moduleName}材料并限时完成`,
      goal: `完成「${title}」的第一轮输入或练习`,
      minutes: stepMinutes,
      guide: `1.找到${moduleName}相关材料；2.计时${stepMinutes}分钟完成；3.记录正确数或产出`,
      microActions: [
        {
          text: `打开${moduleName}相关真题、讲义或知识库资料`,
          material: `${moduleName}真题/讲义/知识库`,
          sourceRef: "当前资料同类题或同类段落",
          timeLimit: "5分钟",
        },
        {
          text: `围绕「${title}」完成一轮限时练习或产出`,
          material: `${moduleName}练习材料`,
          sourceRef: "当前资料第 1 组",
          timeLimit: `${stepMinutes}分钟`,
        },
      ],
      checkCriteria,
      blockers: [
        {
          problem: "不知道用哪份材料",
          solution: `优先使用最近一次错题、知识库资料或搜索「${moduleName} 高频题」。`,
        },
        {
          problem: "时间不够完成全部内容",
          solution: "先完成一组最小练习并记录错因，不临时扩大范围。",
        },
      ],
    },
    {
      action: "订正结果并记录卡点",
      goal: "把本次练习转成可复盘的错题或笔记",
      minutes: Math.max(10, Math.min(20, minutes - stepMinutes)),
      guide: "1.对照答案或标准；2.标出错因；3.写下下一次避免方法",
      microActions: [
        {
          text: "对答案并统计正确数、错误数和耗时",
          material: "答案解析/评分标准",
          sourceRef: "本轮练习结果",
          timeLimit: "5分钟",
        },
        {
          text: "把最关键的 2-3 个错误写入错题表",
          material: "错题表/复盘笔记",
          sourceRef: "错题编号或原句",
          timeLimit: "10分钟",
        },
      ],
      checkCriteria,
      blockers: [
        {
          problem: "看了解析还是不懂",
          solution: "只保留最卡的一题，向 AI 提问并附上题干、你的答案和解析原文。",
        },
      ],
    },
  ];
}
