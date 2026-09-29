1. part assembly
2. orbit maneuver
3. webgpu
1. 更好更詳細的行星 地形 海洋大氣 landscape 雲層 極光 群系 天氣
2. 更好更詳細更多的part 火箭 更多功能什麼降落傘之類 assembly
3. 空氣阻力 動力學 燒蝕 空氣交互 far 空氣升力 飛機
4. 對接
5. rcs sas
6. 存檔管理
7. 地表不動的參照系
8. 其他行星的自定義地形







不許在任何地方用任何fallback 該發生的就發生 不該發生的就panic
每個功能 拆解出來 作一個lab 單獨測試調適通過之後在想辦法串接進去 git 只用來存檔，不開 branch，取捨用 lab」，
操作瀏覽器 來驗證lab有沒按照預期工作的由我來

主遊戲與 lab（2026-09-27）

- 根目錄 src/ 現在以原 lab/flight/src 的整合成果為主遊戲，舊參考遊戲與素材已移出工作目錄並備份。
- lab/flight 是整合驗證入口，直接使用根目錄 src/；不維護另一份主遊戲實作。
- 功能仍在所屬 lab 開發與驗證，主遊戲直接引用；整合接線與遊戲流程在 src/ 修改。
- 功能修改後檢查所屬 lab，以及受影響的整合場景。瀏覽器驗收仍由我操作。
- scenery 已接進主遊戲：layered 地形、地表／海洋 shader、大氣、體積雲和星空。Aurelia / Terra 預設 layered，繪圖與碰撞共用地形設定，發射點在乾燥低地。
- 大氣與海洋目前只影響畫面；空氣阻力、升力、熱與浮力仍待開發。shader 和 headless 檢查通過後，瀏覽器整合驗收仍由我操作。

WebGPU / compute 待辦（尚未實作）

- 先做獨立 WebGPU lab，驗證指定環境、Three.js 材質與地形渲染；不支援就明確 panic，不切換後端。
- 對照現有 WebGL2 場景量測 CPU/GPU 時間、畫面正確性和記憶體，再整合進主遊戲。
- compute shader 另作實驗：優先評估地形生成或大氣查找表；納入上傳、讀回與同步成本。
- compute 的結果若需交給 CPU / Rapier，必須驗證精度、資料一致性和整體效益；切換渲染後端不代表 CPU 計算自動搬到 GPU。



1. lod效能問題 gpu  (okay)
2. lod 地形問題 自定義地形 (okay)
3. ui  view切換優化 (okay)
4. orbit 完整merge進來 (okay)
5. 給火箭更優越的isp 跟推力 哪怕沒有真實火箭能做到那種程度
6. 視覺上的 海洋 大氣的shader skybox 星空  (okay)
7. 審視一下自轉的那個 (okay)
8. 微調下lod level的超參數配置 (okay)
9. lod大改 按照tile再螢幕上的佔比 決定level  決定要不要畫細的  (okay)

orbit
landing
lodplanet
gamesystem view ui
detail rocket astronant car model
shader texture better planet atmosphere ocean better landscape terrian
human in rocket/ship
part assembly staging



- Maneuver plan: orbit lab's finite-burn flight plan is integrated into the main game's upper-stage free flight, with a panel, map path, and automatic execution. Direct map-node dragging is still pending.
- Atmosphere: scenery's air and clouds are integrated into the main game, with no physical effect yet.
- Attitude: the orbit lab turns the ship instantly. There's no rotational inertia and no reaction wheels (ModuleReactionWheel).
- Multiple ships: landing's EncounterPhysicsGate only does the range and closest-approach prediction. There's no list of ships and no shared physics world for two ships.
- Structure: the rocket is one rigid body with no joint flex, so it can't bend or break.
- Terrain on other bodies: only the home planet has LOD tiles. The other bodies are spheres.
- Clouds: they don't move, cast no shadows, and don't darken the ground's sky light.
Flight physics
- Aerodynamic drag: FlightIntegrator plus DragCube, the six-sided drag table.
- Lift and aircraft: ModuleLiftingSurface, control surfaces, ModuleResourceIntake (jet engines need air).
- Heat: reentry heating, heat conduction, ModuleAblator (heat shields), Radiators/, ModuleCoreHeat, parts overheating and exploding.
- Parachutes (ModuleParachute), landing legs with suspension (ModuleWheels/), wheels, ground vehicles, water buoyancy and splashdown.
- Engines: gimbal (ModuleGimbal), Isp that changes with air pressure, engines with more than one mode (MultiModeEngine), fuel flow order and crossfeed (ModuleToggleCrossfeed), fuel lines and struts (CompoundParts/).
- Parts can break off: impact tolerance, structural limits, explosions.

Controls
- SAS and its hold modes (ModuleSAS): prograde, normal, radial, target, maneuver.
- RCS (ModuleRCS) and translation controls.
- Action groups (AG1–10, gear, lights, brakes), trim, precision control mode.
- Switching between ships, targets, rendezvous display (relative velocity, closest approach).
- Docking ports (ModuleDockingNode) and the grabbing claw (ModuleGrappleNode): merging two ships into one and splitting them again.

Parts and building (the VAB)
- The Part/PartModule architecture itself. Your notes already list this as a next step.
- Attach nodes and surface attach, symmetry (radial and mirror), moving the root part, center of mass/lift/thrust markers.
- Staging editor, part list with categories and search, subassemblies, saving ships (.craft files).
- Checks before launch (PreFlightTests/): missing parachutes, blocked engines, and so on.
- Procedural fairings (ProceduralFairings/), part variants (ModulePartVariants), cargo bays that shield parts (ModuleCargoBay).
- Parts that deploy with animations: solar panels, antennas, radiators, ladders, lights.

Resources and power
- Electricity: solar panels, batteries, generators (ModuleGenerator, ModuleAlternator), what happens when power runs out.
- Other resources: monopropellant, xenon, ore. Mining (ISRU): BaseDrill, ModuleResourceConverter, surface/orbital scanners.

Crew and EVA
- KerbalEVA: going outside, jetpack, climbing ladders, planting flags (FlagSite), carrying items (ModuleInventoryPart, ModuleCargoPart).
- Seats (KerbalSeat), crew in capsules, Experience/ (pilot, engineer and scientist traits and levels).
- IVA (inside-the-cockpit view). Your NOTE has "human in rocket/ship", which fits here.

Game progression
- Science: experiments, biomes (ModuleScienceExperiment), data transmission, science lab.
- Tech tree, funds, reputation, facility upgrades.
- Contracts (Contracts/, FinePrint/: satellites, stations, surveys, rescues), achievements (KSPAchievements).
- CommNet: antennas, relays, signal delay and control (CommNet/), KerbNet.
- Space objects: asteroids and comets (ModuleAsteroid, ModuleComet, SentinelMission).

Game systems
- Saves (quicksave, reverting a flight to launch or to the VAB) and the scene flow: space center → VAB → launchpad → flight → tracking station.
- Converting saves from older versions (SaveUpgradePipeline), settings screen, key rebinding, localization, KSPedia (in-game encyclopedia).
- Audio: engine sound that changes with air density, wind noise, explosions, music. The decompile has an audio/ folder you can check.
- Effects: engine plumes that change with air pressure, reentry flames, dust kicked up on the ground (ModuleSurfaceFX), explosions, camera shake.
- Debug toolbar (DebugToolbar/: cheats, infinite fuel, teleport). This would help a lot with testing labs.

Expansions (optional)
- Robotics (Expansions.Serenity: hinges, rotors, pistons, controllers), deployed surface science.
- Mission editor (Expansions.Missions, from Making History).


blackhole
warp drive light speed relativity special skybox universe


decompile ksp2
decompile ksp
decompile ksa

rainworld in space
