# voice-stealing-controller

JavaScript 游戏音频声部管理库，处理优先级、虚拟化、淡出抢占和预算恢复。
解决 Boss 战等高密度场景下的声部风暴：几十个环境声、脚步声同时触发时，
对话不被截断，低优先级声部不会在空槽出现时疯狂抢占导致听感跳变。

纯决策库：只返回每个声部的目标状态和淡出计划，不做任何混音。

## 安装与运行

```bash
npm test   # node --test
```

无运行时依赖，要求 Node.js 18+。

## 快速上手

```js
import { VoiceManager, VoiceState } from 'voice-stealing-controller';

const vm = new VoiceManager({
  budget: 8,            // 物理声部预算
  protectedSlots: 2,    // 为保护类别预留的名额
  protectedCategories: ['dialogue', 'critical'],
  hysteresis: 5,        // 抢占迟滞（分数差 margin）
  distanceFalloff: 0.5, // 每单位距离的分数衰减
  fadeOutMs: 120,       // 释放淡出时长
});

vm.declare({ id: 'boss-line', category: 'dialogue', priority: 50 });
vm.declare({ id: 'step-1', category: 'footstep', priority: 2, distance: 8 });

const { states, targets, fadePlan, resumed, stolen } = vm.update(nowMs);
// states:   每个声部当前状态（playing / virtual / fading）
// targets:  每个声部的目标状态（playing / virtual）
// fadePlan: 本次进入释放淡出的声部 [{ id, fadeOutMs, startAt }]
// resumed:  本次从 virtual/fading 恢复为 playing 的声部
// stolen:   本次被抢占进入淡出的声部
```

每帧用最新数据调用 `declare()` / `updateVoice()`（距离、已播放时间等会变化），
然后调用 `update(now)` 获取决策。声部结束或实体销毁时调用 `remove(id)`。
预算变化时调用 `setBudget(n)`，下一次 `update` 会返回对应的淡出计划。

## 评分模型

每个声部的有效分数：

```
score = priority - distance * distanceFalloff + finishBonus
```

- `priority`：声明的基础优先级，越高越重要。
- `distance`：距离衰减，超过 `maxDistance` 后不再继续扣减。
- `finishBonus`：剩余播放时间 ≤ `finishBonusWindowMs` 时加分，
  让即将播完的长音频自然收尾，而不是在结尾前被切掉。

## 虚拟化规则

- 物理预算 `budget` 决定同时 `playing` 的声部上限；超出的声部转为 `virtual`，
  不占用物理通道，由游戏侧自行决定静默、降采样或仅更新逻辑位置。
- 保护类别（默认 `dialogue`、`critical`）独占 `protectedSlots` 个名额，
  普通音效分数再高也不能占用；保护名额未被使用时，普通声部可以使用剩余预算。
  保护声部超出预留名额后，溢出的部分进入普通池参与竞争。
- 虚拟声部恢复时**重新按当前分数排序**，分数最高者优先恢复，
  不按进入虚拟状态的先后顺序（非 FIFO）。
- 预算缩小时，`update` 只返回淡出计划和目标状态；
  淡出中的声部在 `fadeOutMs` 结束后转为 `virtual`，期间不计入预算。

## 抢占规则

- **现任保护（hysteresis）**：正在播放的声部不会被分数接近的挑战者换掉。
  挑战者分数必须超过最弱现任者 `hysteresis` 以上才能抢占，
  因此相同或相近优先级的声音不会逐帧互换，声明顺序变化也不会引起抖动。
- **对话即时回收**：保护类别的声部进入时立即获得预留名额，
  不经过 hysteresis，保证对话和关键提示零延迟开播。
- **淡出释放**：被抢占或预算缩减挤出的声部进入 `fading` 状态，
  由 `fadePlan` 描述淡出参数；本库不执行实际增益 ramp，混音由集成方负责。
- **淡出可撤销**：淡出未完成前预算恢复或抢占者消失，
  该声部直接回到 `playing`，不重新起播。
- **同分决胜**：分数相同优先保留正在播放的声部，其次按声明顺序，
  保证结果确定、可复现。
