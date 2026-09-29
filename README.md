# VOID

主遊戲以我們在 `lab/flight` 完成的初步整合為基礎，入口是根目錄 `src/main.ts`。

```sh
npm install
npm run dev        # 主遊戲；開啟 Vite 印出的網址
npm run check      # flight 的整合檢查，直接測試根目錄 src/
npm run typecheck
npm run build
```

目前主遊戲使用 Three.js 的 WebGL2 後端、Rapier 接觸物理、orbit lab 的軌道計算，以及 scenery lab 的地形、大氣、體積雲、海洋材質與星空。WebGPU / compute 的實驗與整合列在 `NOTE.md`，尚未切換。

## 開發分工

- `src/`：主遊戲入口、整合接線、座標轉換、HUD 和遊戲流程。
- `lab/orbit`、`lab/lod`、`lab/landing`、`lab/view`、`lab/navball`、`lab/scenery`：各功能的原始碼與獨立驗證場景。主遊戲直接引用所需功能。
- `lab/assembly`、`lab/sas`：尚未接進主遊戲的功能 lab。
- `lab/flight`：整合驗證入口，啟動同一份 `src/main.ts`，保留既有啟動與檢查指令。

功能問題在所屬 lab 修正，整合問題在 `src/` 修正；不要複製功能來維護第二份實作。功能介面或假設改變時，同步更新使用者並驗證受影響的 lab 與主遊戲。瀏覽器驗收由使用者操作。

Git 維持單一分支存檔。一次完整的介面修改與呼叫更新一起提交；進度存檔與已驗證版本要明確區分。完成整合驗收後，可用 tag 標記整個專案的相容版本。

## 整合場景

主遊戲沿用 flight 的操作、行星參數與除錯工具，詳見 [Flight Lab](lab/flight/README.md)。`?planet=aurelia` 是預設場景。開發模式的日誌仍寫入 `lab/flight/lab-log/`，正式建置不啟用這個日誌服務。

Aurelia、Aurelia-fast 和 Terra 預設使用 scenery 的 layered 地形，繪圖 worker 和 Rapier 碰撞共用同一份地形設定；發射點是海平面以上的低地。`?planet=aurelia&terrain=hills` 可以比較舊地形，該模式預設關閉海洋以保留原本發射點。Luna 與 Pebble 保留原地形並且沒有大氣與海洋。

按反引號打開 DEV 面板，可切換大氣、雲、海洋與星空，並調整曝光。大氣和海洋目前是視覺效果，尚未加入空氣阻力、升力、再入熱或浮力。海洋顯示在海平面，固體碰撞仍在實際海床；不要把海面當成可降落的固體表面。

上級分離並進入自由飛行後，右下角會出現 MANEUVER 面板。可新增多個燃燒、設定開始時間與順行／法向／徑向 Δv、選擇參考天體、定位到下一個近拱點或遠拱點，並用「Warp to burn」停在點火前 30 秒。地圖上的橘線是包含有限時間燃燒的計畫軌跡，藍線仍是目前無推力滑行預測。到達開始時間後，上級引擎依計畫全推力自動燃燒；燃燒中不能修改該節點。此功能沿用 orbit lab 的 `FlightPlan`，只支援已分離的上級在自由飛行中規劃及執行；目前火箭仍不會自動分級。

瀏覽器驗收可依序查看發射點地面、上升穿雲、縮放到軌道與切換天體焦點，再查看自轉後的日夜光照、暫停／重置和 DEV 各個開關。程式檢查與 shader 生成不代表這些畫面已由使用者驗收。

## 舊參考遊戲

原根目錄的 `src/` 與 `public/` 已移除，清理前的程式、素材、根目錄設定與 flight 原始整合程式備份在專案外：

`/home/pekka/Desktop/void-legacy-reference-20260927.tar.gz`

舊程式也仍存在 Git 歷史中。
