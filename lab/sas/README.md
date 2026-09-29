# SAS Lab

KSP 式的姿態穩定（Stability Assist）。控制器在 `src/StabilityAssist.ts`，尚未接進主遊戲。

```sh
cd lab/sas
npm install
npm run dev -- --port 5198
npm run check
npm run build
```

## 操作與驗收

- `T` 或 SAS 按鈕開關；`W`/`S` 俯仰、`A`/`D` 偏航、`Q`/`E` 滾轉，與主遊戲相同；`K` 或按鈕施加隨機角速度。
- 頁面沒有阻尼：SAS 關閉時一旦轉起來就不會停。這是之後主遊戲拿掉 `ANGULAR_DAMPING` 後的行為。
- 驗收：
  1. SAS 開、踢一下 → 偏離後回到灰色箭頭（鎖定姿態），不來回擺盪。
  2. 按住一個方向鍵 → 只有該軸轉；放開 → 先停下，再鎖住新的姿態（灰色箭頭移到新位置），不會被拉回原本方向。
  3. SAS 開啟時正在旋轉 → 先減速，停下後才鎖定。
  4. 切換 Full stack / Upper stage、調整慣量倍率（0.25–4 倍，模擬燃料消耗或更重的載具），行為一致，只有快慢不同。
  5. 圖表：藍線為與鎖定姿態的角度，橘線為角速度，紫線為最大指令（不超過 1）。

瀏覽器畫面與互動由使用者驗收。

## 控制方式

- 輸出與玩家按鍵相同的 `turn` 指令（每軸 −1 到 1，乘上 lab/landing 的 `STEERING_TORQUE`），SAS 不會比按鍵有更大的力矩。
- 每軸的期望角速度：遠處取「以 `brakeFraction` 倍的角加速度能剛好停下」的 √(2 b a |e|)，近處取線性 |e| / `attitudeSeconds`；角速度迴路再以 `rateSeconds` 要求角加速度。力矩 = Iα + ω×Iω；任一軸超過上限時整個向量等比縮小，方向不變。
- `attitudeSeconds ≥ 4 × rateSeconds`，線性區為臨界阻尼或更慢；不符合的調參直接 panic。
- 姿態與角速度都在物理積分的座標系（行星本體固定座標）中，「保持」即在該座標系中靜止。

## 與 lab/landing 的介面

- `LanderControl.steering`：每個物理步呼叫一次，傳入該步開始時受控單元（堆疊或分離後的上級）的姿態、角速度與慣量，回傳該步的 `turn`。contact 與 flight 模式皆同；與 `turn` 同時給會 panic。
- `PartJointRocket.controlledInertia()`：受控單元的慣量（上級的局部座標）。

`npm run check` 使用 lab/landing 的姿態積分器（無阻尼）與 demo 火箭真實的慣量，驗證：被踢後回到鎖定姿態（過衝、收斂時間、指令不超過上限）、按鍵軸直通且其他軸被阻尼、放開後鎖定新姿態、關閉時不干預、旋轉中開啟、錯誤輸入 panic，以及透過 `PartJointRocket` 在 contact 與 flight 模式中每步呼叫一次並保持姿態。

## 待辦

- 拿掉 `ANGULAR_DAMPING`（lab/landing，contact 與 flight 皆然），同時把 SAS 接進主遊戲（`T` 鍵、HUD 燈號）。兩者一起做，避免主遊戲出現停不下來的旋轉。
- KSP 的其他 SAS 模式（順行／逆行／法向／徑向／目標／機動點）尚未實作。
