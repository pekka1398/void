不許在任何地方用任何fallback 該發生的就發生 不該發生的就panic
每個功能 拆解出來 作一個lab 單獨測試調適通過之後在想辦法串接進去 git 只用來存檔，不開 branch，取捨用 lab」，
操作瀏覽器 來驗證lab有沒按照預期工作的由我來

主遊戲與 lab（2026-09-27）

- 根目錄 src/ 現在以原 lab/flight/src 的整合成果為主遊戲，舊參考遊戲與素材已移出工作目錄並備份。
- lab/flight 是整合驗證入口，直接使用根目錄 src/；不維護另一份主遊戲實作。
- 功能仍在所屬 lab 開發與驗證，主遊戲直接引用；整合接線與遊戲流程在 src/ 修改。
- 功能修改後檢查所屬 lab，以及受影響的整合場景。瀏覽器驗收仍由我操作。

WebGPU / compute 待辦（尚未實作）

- 先做獨立 WebGPU lab，驗證指定環境、Three.js 材質與地形渲染；不支援就明確 panic，不切換後端。
- 對照現有 WebGL2 場景量測 CPU/GPU 時間、畫面正確性和記憶體，再整合進主遊戲。
- compute shader 另作實驗：優先評估地形生成或大氣查找表；納入上傳、讀回與同步成本。
- compute 的結果若需交給 CPU / Rapier，必須驗證精度、資料一致性和整體效益；切換渲染後端不代表 CPU 計算自動搬到 GPU。






orbit
landing 
lodplanet
gamesystem view ui
detail rocket astronant car model 
shader texture better planet atmosphere ocean better landscape terrian
human in rocket/ship
part assembly staging





blackhole
warp drive light speed relativity special skybox universe


decompile ksp2
decompile ksp
decompile ksa

rainworld in space
