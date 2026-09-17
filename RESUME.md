# 寮€鏈虹画鎺ユ寚鍗楋紙RESUME锛?
> 鏇存柊锛?026-09-17锛坴1.1.13 淇銆屽埛鏂板悗澶辫触浠诲姟鐐归噸璇曟病鍙嶅簲銆嶏紱
> **骞舵帓鏌ュ嚭鐪熸鐨勪笂浼犲け璐ユ牴鍥狅細瀛樺偍鐩?N: 鍐欐弧锛孧inIO 鎶?XMinioStorageFull**锛夈€?> 涓嬫缁х画寮€鍙?娴嬭瘯鍓嶅厛璇绘湰鏂囥€?
## 0. 鈿狅笍 澶村彿杩愮淮绾㈢嚎锛氬瓨鍌ㄧ洏鍐欐弧 = 鎵€鏈変笂浼犲け璐ワ紙2026-09-17 瀹炴祴锛?
- MinIO 鏁版嵁鐩綍 = 瀹夸富鏈?**`N:\minio-data-single`**锛坥verride 閲?bind 鍒板鍣?`/data1`锛?  鍚姩鍙傛暟 `minio server /data1`锛夈€?*N: 鐩?200GB 鍐欐弧锛堝彧鍓?6MB锛夋椂**锛?  - 鏈嶅姟绔棩蹇楄繎 7 澶?**2252 娆?* `XMinioStorageFull: Storage backend has reached its minimum
    free drive threshold`锛屽叏閮ㄥ彂鐢熷湪 `initUpload`锛坄POST /api/files/upload/init`锛?  - 鐜拌薄灏辨槸鐢ㄦ埛鐪嬪埌鐨勩€屼笂浼犱换鍔″け璐ャ€嶁€斺€?*鍜屽墠绔€佺綉缁滈兘鏃犲叧锛屾槸纾佺洏婊′簡**
- **鐗堟湰鎺у埗鏄紑鍚殑**锛坄mc version info nd/netdisk-data` 鈫?enabled锛夛細
  銆屽垹闄ゆ枃浠躲€嶅彧鏄墦**鍒犻櫎鏍囪**锛?*绌洪棿涓嶉噴鏀?*锛涘巻鍙茬増鏈細涓€鐩村崰鐩樸€?  瀹炴祴娓呯悊鍓嶏細`137 GiB Used / 31634 Objects / 52687 Versions / 18322 Delete Markers`锛?  鑰屾暟鎹簱瀛樻椿鏂囦欢鍙湁 2587 涓?鈥斺€?绌洪棿鍑犱箮鍏ㄨ鍘嗗彶鐗堟湰涓庡垹闄ゆ爣璁板悆鎺夈€?- **鏃ュ父鎺掓煡涓夎繛**锛堝彂鐜颁笂浼犺帿鍚嶅け璐ュ厛璺戣繖涓級锛?  ```powershell
  [System.IO.DriveInfo]::new('N').AvailableFreeSpace/1GB          # 鍓╀綑绌洪棿锛?10GB 灏变細鎷掑啓锛?  docker exec netdisk-minio sh -c "df -h /data1"                   # 瀹瑰櫒鍐呰瑙?  docker logs netdisk-server --since 24h 2>&1 | Select-String XMinioStorageFull
  ```
- **鍥炴敹绌洪棿锛堝畨鍏ㄩ『搴忥級**锛?  ```powershell
  $u=(Select-String -Path .env -Pattern '^MINIO_ROOT_USER=').Line -replace '^MINIO_ROOT_USER=',''
  $p=(Select-String -Path .env -Pattern '^MINIO_ROOT_PASSWORD=').Line -replace '^MINIO_ROOT_PASSWORD=',''
  .\mc.exe alias set nd http://127.0.0.1:9000 $u $p --api S3v4
  .\mc.exe rm --incomplete --recursive --force nd/netdisk-data            # 1) 鏈畬鎴愬垎鐗囦笂浼犳畫鐣?  .\mc.exe rm --recursive --force --versions --non-current nd/netdisk-data # 2) 闈炲綋鍓嶇増鏈?鍒犻櫎鏍囪
  .\mc.exe admin info nd                                                   # 3) 澶嶆牳 Used/Objects/Versions
  ```
  > 娉ㄦ剰锛氭竻鐞嗗墠鍏?`pg_dump`锛堣 `docs/04-澶囦唤涓庢仮澶?md`锛夛紝骞剁‘璁?*褰撳墠鍙鏂囦欢涓嶅彈褰卞搷**
  > 锛坄--non-current` 涓嶅姩褰撳墠鐗堟湰锛夛紱浠ｄ环鏄け鍘汇€岀増鏈洖婊?璇垹鎭㈠銆嶈兘鍔涖€?  > 鍙︼細`N:\minio-data-backup-20260826`锛?4.5GB 闄堟棫鍘熷鍓湰锛夊凡浜?2026-09-17 绉诲埌 `E:\`锛?  > 鏈垹闄わ紱`.env`/override 鏈敼鍔ㄣ€?
## 0. 鈿狅笍 浜嬫晠璁板綍涓庢晳鎻达紙2026-09-17锛夛細鏁存《璇垹锛屾鍦ㄥ弽鍒犻櫎鏁戞彺

### 鍙戠敓浜嗕粈涔?鎵ц銆屾竻鐞嗗鍎垮璞°€嶆椂鐢ㄤ簡锛?`mc rm --recursive --force --versions --stdin nd/netdisk-data < 娓呭崟鏂囦欢>`
**鍦ㄥ惎鐢ㄧ増鏈帶鍒剁殑妗朵笂锛岃鍛戒护浼氬拷鐣?stdin 娓呭崟锛岀洿鎺ラ€掑綊鍒犻櫎璺緞鍙傛暟锛堟暣涓《锛変笅鐨勪竴鍒?*銆?瀹炴祴澶嶇幇锛氫复鏃舵《閲屽彧鍒?2 涓?key锛屾墽琛屽悗 5 涓璞″叏琚垹锛涙崲鎴愰潪鐗堟湰鍖栨《鍒欏彧鍒犳竻鍗曞唴鐨?2 涓€?锛堟鍓嶅彧鐢?鍗曚釜 key"璇曞垹杩囷細閭ｆ椂璺緞鍙傛暟鎭板ソ灏辨槸閭ｄ釜 key锛屾墍浠ョ湅璧锋潵姝ｇ‘ 鈥斺€?閿欒鐨勬帹骞裤€傦級
鍚庢灉锛歚netdisk-data` 鍏ㄩ儴瀵硅薄琚墿鐞嗗垹闄わ紙2587 涓湪绾挎枃浠?67GB + 鍥炴敹绔?11GB + 鍘婚噸姹犲璞★級銆?
### 鐜扮姸
- **鏁版嵁搴撳畬濂?*锛氭枃浠?鐩綍鏍戙€佹枃浠跺悕銆佸ぇ灏忋€?*B3SEG 鍝堝笇**銆乣object_key`銆乷wner銆佹椂闂村叏鍦ㄣ€?- **宸插仛鐨?鎭㈠姝ｅ父"澶勭疆锛?026-09-17锛?*锛氭妸 2587 鏉?鍐呭宸蹭涪澶?鐨勬枃浠惰绉诲叆**鍥炴敹绔?*
  锛坄is_deleted=true`锛宍object_key` 鍘熸牱淇濈暀锛夆啋 涓诲垪琛ㄤ笉鍐嶆湁鎵撲笉寮€鐨勭┖澹虫潯鐩紱**590 涓洰褰曚繚鐣?*锛?  鍘熺洰褰曠粨鏋勮繕鍦紝渚夸簬鎸夊師浣嶇疆閲嶄紶銆傚簱鍐呭彟瀛樹簡瀹屾暣澶囦唤琛細
  `lost_20260917_files`锛?739 琛岋級銆乣lost_20260917_file_versions`锛?776 琛岋級銆乣lost_20260917_dedup_pool`锛?444 琛岋級銆?- **鍙敤鎬у疄娴嬶紙2026-09-17 鍏ㄩ儴閫氳繃锛?*锛?  - N: 200GB / 宸茬敤 46.9GB / **绌洪棽 153.1GB**
  - MinIO 鐪熷疄瀛樺偍璺緞锛堝鍣?`/data1` 鈫?N: bind锛夊啓鍏?2MB 鈫?stat 鈫?璇诲洖锛?*SHA-256 瀹屽叏涓€鑷?*
  - 绔埌绔細涓婁紶 鈫?鍚屽悕鍐嶄紶鍛戒腑绉掍紶 鈫?鍒犻櫎瀵硅薄鍚庡悓鍚嶅啀浼狅紙瀹堝崼鐢熸晥璧扮湡瀹炰笂浼狅級鈫?涓嬭浇鍐呭涓€鑷?    锛坄node e2e/_test-dedup-guard.mjs`锛屽叏閮ㄩ€氳繃锛?  - 涓诲垪琛?HRTTP 200 涓旀棤绌哄３鏉＄洰锛涘洖鏀剁珯 2739 鏉★紱鍒楄〃/鍥炴敹绔欐帴鍙ｆ甯?- **鏁戞彺鎴愬姛鍚庣殑鎭㈠鍔ㄤ綔**锛氬璞℃斁鍥炲師 key 鍚庯紝杩涖€屽洖鏀剁珯銆嶅叏閫?鈫?**鎭㈠**锛岃繖浜涙潯鐩嵆鍙噸鏂板彲瑙?鍙笅杞?  锛坄object_key` 鏈彉锛屾棤闇€鏀瑰簱锛夈€傝嫢鏁戞彺鍙崬鍥炰竴閮ㄥ垎锛屽垯鍙仮澶嶉偅閮ㄥ垎瀵瑰簲鐨勬潯鐩嵆鍙€?- MinIO锛歚/data1/netdisk-data` 浠呭墿绾?700MB 鍏冩暟鎹紝瀵硅薄涓嶅瓨鍦ㄣ€?- `vssadmin` 鏌?N: **鏃犲嵎褰卞壇鏈?*锛沗backups/` 鍙湁 pg_dump锛堟棤瀵硅薄锛夈€?- `E:\minio-data-backup-20260826`锛?/26 閭ｄ唤锛夋槸**8/27 宸茬‘璁ゅ垹闄ょ殑鑰佹暟鎹?*锛屾娊鏍?0/20 鍛戒腑褰撳墠鏂囦欢锛屾晳涓嶄簡杩欐銆?- 鍏抽敭鍓嶆彁锛氫笅杞芥帴鍙?`presignGet(object_key)` **涓嶉攣 version_id**锛堟寜 key 鍙栧綋鍓嶇増鏈級
  鈫?**鍙鎶婂璞″唴瀹规斁鍥炲師 key锛岀綉鐩樻棤闇€鏀瑰簱鍗冲彲鎭㈠**锛坄version_id` 鍙奖鍝嶅巻鍙茬増鏈洖婊氾級銆?
### 鏁戞彺姝ラ锛堝凡澶囧ソ鑴氭湰锛岃剼鏈凡鑷祴閫氳繃锛?```powershell
# 1) 绔嬪埢姝㈡崯锛氫笉瑕佸啀寰€ N: 鍐欎换浣曚笢瑗匡紙鍒笂浼犮€佸埆鎷锋枃浠惰繘鍘伙級锛孌ocker 鍙繚鎸佽繍琛?# 2) 鐢ㄥ弽鍒犻櫎宸ュ叿鎶婃暣妫电洰褰曟寜"淇濈暀璺緞"鎭㈠鍒版殏瀛樼洰褰曪紙**缁濅笉鑳芥仮澶嶅埌 N:**锛?#    鐩爣璺緞锛歂:\minio-data-single\netdisk-data     鎺ㄨ崘宸ュ叿锛欴iskGenius / R-Studio / Recuva
#    绾鍚嶆仮澶嶏紙PhotoRec 鏃犺矾寰勶級涔熻鈥斺€旇剼鏈細鎸夊唴瀹瑰搱甯岃嚜鍔ㄥ尮閰?#    鏆傚瓨鐩綍寤鸿锛欵:\recover-stage 锛圗: 闇€瀹圭撼 ~73GB锛?# 3) 鍒嗘瀽锛堝彧璇伙紝涓嶅姩鏁版嵁锛?$env:STAGE='E:\recover-stage'; node e2e/_rescue-rebuild.mjs analyze
# 4) 鍥炰紶锛堟牎楠岄€氳繃鐨勫璞℃墠涓婁紶鍒板師 key锛歮c cp 鍒?nd/netdisk-data/<鍘?key>锛?$env:STAGE='E:\recover-stage'; node e2e/_rescue-rebuild.mjs restore
# 5) 澶嶆牳
node e2e/_verify-storage-integrity.mjs
```
- 鑴氭湰鍒ゅ畾渚濇嵁锛堥€愪竴楠岃瘉锛屼笉鐚滐級锛氭枃浠跺璞＄敤 `files.size_bytes` + `files.sha256`锛圔3SEG锛夛紱
  鍘婚噸姹犲璞＄敤 `dedup_pool.size_bytes` + key 鏈熬鐨?sha256 娈点€?  鏀寔鍗曠洏甯冨眬鐨?`part.1鈥art.N` 鍒嗙墖鎷兼帴涓庡皬瀵硅薄"鍐呰仈鍦?xl.meta 灏鹃儴"涓ょ褰㈡€併€?- 浜х墿锛歚E:\netdisk-backups\recovery-plan.json`锛堝洖浼犺鍒掞級銆乣recovery-missing.csv`锛堟晳涓嶅洖鏉ョ殑瀵硅薄锛夈€?  `lost-manifest.csv`锛?587 涓涪澶辨枃浠剁殑瀹屾暣璺緞/澶у皬锛屼緵瀵圭収鏈湴鍘熶欢閲嶄紶锛夈€?- 鑷祴璁板綍锛歚node e2e/tmp/_rescue-selftest.mjs` 鈫?鍒嗙墖瀵硅薄涓庡唴鑱斿璞″潎鎭㈠銆侀敊璇唴瀹硅鎷掋€?  鎷兼帴缁撴灉涓庡師濮嬪瓧鑺傚畬鍏ㄤ竴鑷达紱`restore` 閫氶亾瀹炴祴 2/2 涓婁紶鎴愬姛銆?
### 姘镐箙绂佷护锛堝啓姝诲湪杩欓噷锛岄伩鍏嶉噸鐘級
1. **绂佹** `mc rm --recursive --force --versions --stdin <alias>/<bucket>` 杩欑"娓呭崟+閫掑綊"缁勫悎锛?   鐗堟湰鍖栨《涓嬪垹闄?*蹇呴』閫?key 鎸囧畾瀹屾暣璺緞**锛歚mc rm --recursive --force --versions nd/netdisk-data/<key>`銆?2. 浠讳綍鎵归噺鍒犻櫎鍓嶅繀椤诲厛璺?*鏁版嵁搴撳弽鏌?*锛坒iles / file_versions / upload_sessions / dedup_pool / sha256 娲剧敓
   鍏潯閫氶亾鍏ㄩ儴 0 寮曠敤锛夛紝骞剁敤 `--dry-run` 鎴栦复鏃舵《楠岃瘉**鍛戒护褰㈠紡鏈韩**锛岃€屼笉鏄彧楠岃瘉娓呭崟鍐呭銆?3. 澶ф竻鐞嗗墠鍏堝仛 `pg_dump` + **瀵硅薄闀滃儚**锛坄mc mirror`锛夛紝涓嶈鍙浠藉厓鏁版嵁銆?
## 1. 褰撳墠鐘舵€佸揩鐓э紙2026-09-17 鏍稿锛?
- 5 瀹瑰櫒锛歚netdisk-server` / `netdisk-web` / `netdisk-minio` / `netdisk-postgres` / `netdisk-redis`锛堝叏閮?healthy锛?- **MinIO 鎷撴墤锛氬崟鐩?*锛堥粯璁ゅ懡鍚嶅嵎 `minio-data`锛涙湰鍦?override 鍗曠洏 bind 鍒?`N:\minio-data-single`锛?  鏃?4 鐩樼籂鍒犵爜鏁版嵁鍦?`N:\minio-data\data1..4` 宸蹭笉鍐嶈鍙栵紝纭鏃犻渶鍚庡彲鍒犻櫎閲婃斁绌洪棿锛?- **Redis 鐑偣缂撳瓨**锛氱洰褰曞垪琛紙`dir:{orgId}:{userId}:{dirId}`锛孴TL 30s锛? 鍒嗕韩鍏冧俊鎭紙`share:{token}`锛孴TL 15s/鍒版湡绮剧‘锛夛紱鍐欐搷浣滀富鍔ㄥけ鏁堬紱鏉冮檺瀹炴椂鏍￠獙涓嶇紦瀛?- **PostgreSQL 瀹為檯鏁版嵁**锛?026-09-17 澶囦唤鍓嶅疄娴嬶級锛歚files=2587`锛堟椿璺冿紝67GB锛夈€乣directories=588`銆?  鍥炴敹绔?152 椤癸紙11GB锛夈€乣dedup_pool=1496`锛?8GB锛夈€乣users=2`锛坅dmin 绠＄悊鍛?+ demo 婕旂ず璐﹀彿锛?  - 娉細2026-08-27 鏇炬寜鐢ㄦ埛纭娓呯┖鍏ㄩ儴鏁版嵁锛堝惈 21k 娴嬭瘯鐩綍锛夛紝姝ゅ悗涓烘柊涓€杞湡瀹炰笂浼犳暟鎹?- **MinIO 渚у璞?*锛歚31634 Objects / 52687 Versions / 18322 Delete Markers`锛堟竻鐞嗗墠锛?- **閮ㄧ讲鐗堟湰**锛歸eb/server 鍧囦负 **v1.1.13**锛堥暅鍍忔瀯寤?2026-09-17锛屼唬鐮佷笌闀滃儚涓€鑷村凡鏍稿锛?  - v1.1.11锛氫慨澶嶃€屼笂浼犵洰鏍囩洰褰曞凡鍒犻櫎銆?04 椋庢毚锛堢珛鍗冲け璐?+ 鏁存壒娓呯悊 + 鎸夌洰褰曟殏鍋滐級
  - v1.1.12锛氬叏鍔熻兘浣撴 33 椤归€氳繃锛涗慨澶嶄换鍔￠潰鏉?z-index 閬尅琛屽唴涓嬫媺鑿滃崟
  - v1.1.13锛氬埛鏂板悗澶辫触浠诲姟鍙€岄噸鏂伴€夋嫨鏂囦欢銆嶆柇鐐圭画浼狅紱retryTask/鎵归噺閲嶈瘯瑙ｉ櫎闃熷垪鏆傚仠锛?    灏忔枃浠惰嚜鍔ㄧ画浼犱笉鍐嶄骇鐢熼噸澶嶄换鍔★紙璇﹁ CHANGELOG锛?- Docker VM锛?GB / 4 鏍革紙`.wslconfig`锛夛紱闀滃儚鍔犻€?`docker.m.daocloud.io`
- **浠ｇ爜浠撳簱锛氬凡鍒濆鍖?git 骞舵帹閫?GitHub** 鈥斺€?https://github.com/474lilin/netdisk锛圥ublic锛?  - 鏈湴鐩綍 `N:\濂囨€濆鎯砛minio-netdisk`锛涜繙绔?`origin`
  - `.gitignore` 宸叉帓闄?`.env`/澶囦唤/娴嬭瘯娈嬬暀/鏈満 override锛?env 浠呭瓨鏈湴锛屼笉鍏ュ簱锛?  - 鎺ㄩ€佸懡浠わ細`git add -A && git commit -m "..." && git push`
- 澶囦唤鏂瑰紡锛歚docs/04-澶囦唤涓庢仮澶?md`锛坧g_dump + mc mirror锛夛紱
  2026-09-17 娓呯悊鍓嶅浠斤細`E:\netdisk-backups\nd-pre-cleanup-20260917-1305.dump`锛?.1MB锛?
## 2. 寮€鏈洪噸鍚楠?
```powershell
# 1) 鍚姩 Docker Desktop锛岀瓑寰呭紩鎿庡氨缁紙鎵樼洏鍥炬爣鍙樼豢锛?# 2) 鍚姩鏁村鏈嶅姟锛堜唬鐮佹棤鏀瑰姩鍒欐棤闇€ --build锛涙湁鏀瑰姩鐢?--build锛?cd N:\濂囨€濆鎯砛minio-netdisk
docker compose up -d
# 3) 绛夊緟鍋ュ悍锛堢害 30-60s锛?docker compose ps          # 鍏ㄩ儴 healthy 鍗冲彲
curl http://127.0.0.1:8080/api/health   # {"ok":true,"db":true,"minio":true}
```

> 璇存槑锛歚docker-compose.override.yml` 褰撳墠灏?MinIO 鏁版嵁 bind 鍒?N: 鐩橈紙10GB 瀹炴祴鐢ㄤ复鏃堕厤缃級銆?> 鑻?C: 鐩樼┖闂村厖瓒冲彲鍒犻櫎璇ユ枃浠舵仮澶嶉粯璁ゅ懡鍚嶅嵎锛堟洿蹇級锛汵: 鐩樺墿浣欑害 52GB銆?> 閲嶅缓 server 瀹瑰櫒鏃犻渶閲嶅惎 web锛歯ginx 宸查厤缃姩鎬佽В鏋愶紙resolver 127.0.0.11 + 鍙橀噺 proxy_pass锛夛紝
> 鏈€闀?10s 鍐呰嚜鍔ㄦ仮澶嶏紙瑙佺 7 鑺?nginx 鍔ㄦ€佽В鏋?锛夈€?
## 3. 寮€鏈哄悗蹇€熷洖褰掞紙鎸夐渶锛?
```powershell
# 鍘婚噸涓撻」锛圓-E锛岀害 5-6 鍒嗛挓锛?node deploy/scripts/smoke-dedup.mjs
# Redis 缂撳瓨涓撻」锛堢害 1 鍒嗛挓锛?node deploy/scripts/smoke-redis-cache.mjs
# 600MB 鍥炲綊
node deploy/scripts/smoke-b3-600.mjs
# 涓婁紶/涓嬭浇鍚炲悙鍩虹嚎
node deploy/scripts/bench-io.mjs 512
# 10GB BLAKE3 鍩哄噯
node deploy/scripts/bench-b3.mjs
# 娴忚鍣?e2e
cd e2e && node browser-e2e.mjs
# 鍒锋柊鍚庨噸璇曚慨澶嶄笓椤癸紙v1.1.13锛?脳40MB + 6MB 涓婁紶涓埛鏂?鈫?閲嶉€夋枃浠舵柇鐐圭画浼狅紝绾?2-4 鍒嗛挓锛?cd e2e && node _ui-retry-after-refresh.mjs
# 鏂偣璁板綍鍐欏叆鏍告煡锛圛ndexedDB锛涘惈"姹℃煋搴撹嚜鎰?鍦烘櫙锛?cd e2e && node _probe-resume-idb.mjs
# 瀛樺偍瀹屾暣鎬ф牳楠岋紙瀵圭収鏁版嵁搴撴牳瀵规瘡涓瓨娲绘枃浠剁殑瀵硅薄鍙鎬?+ 鎶芥牱 B3SEG 鍝堝笇锛岀害 5-8 鍒嗛挓锛?#   鍓嶇疆锛氶渶鍏堢敓鎴愭竻鍗曪紙瑙?docs/04-澶囦唤涓庢仮澶?md 鎴?CHANGELOG v1.1.13 璇存槑锛?cd e2e && node _verify-storage-integrity.mjs
# 鍥炴敹绔?鏂囦欢椤垫壒閲忔搷浣滃垎鎵瑰洖褰掞紙閫?105 鐩綍鈫掑叏閫夊垹闄も啋鍏ㄩ€夊交搴曞垹闄も啋娓呯┖锛岀害 2 鍒嗛挓锛?cd e2e && node _trash-batch-full.mjs
# 浣撻獙鏂█鍥炲綊锛堣〃鍗曟牎楠?鎸夐挳鎬?鏉冮檺/鍗忚寮圭獥/绉诲姩绔紝绾?1 鍒嗛挓锛?cd e2e && node _ux-assert.mjs
# 鍒嗕韩椤典笓椤癸紙闈㈠寘灞戝鑸?鐩綍鍐呬笅杞?鏃犳晥鍒嗕韩鍖哄垎锛岀害 1 鍒嗛挓锛?cd e2e && node _share-ux.mjs
# 鍏ㄥ QA锛堢害 40-60 鍒嗛挓锛汿4 鍚?520 鏂囦欢涓婁紶绾?12-18 鍒嗛挓锛?node deploy/scripts/_qa-t1.mjs; node deploy/scripts/_qa-t2.mjs; node deploy/scripts/_qa-t3.mjs
cd e2e && node _qa-t4.mjs; cd ..; node deploy/scripts/_qa-t5.mjs
```

## 4. 宸插畬鎴愮殑寮€鍙戝唴瀹癸紙鎴嚦 Redis 缂撳瓨锛?
> 瀹屾暣鍗囩骇璁板綍瑙佹牴鐩綍 **CHANGELOG.md**锛堟瘡娆″彂甯冪殑鍔熻兘/淇/閰嶇疆鍙樻洿锛屾寜鐗堟湰褰掓。锛夛紱鏈枃鎸夊姛鑳藉綊绫汇€?
1. **BLAKE3/B3SEG 鍏ㄩ摼璺?*锛歚server/src/lib/blake3.ts`锛坵orker_threads 骞惰锛? `web/src/utils/hash.ts`
   锛圵eb Worker锛? 娴嬭瘯鍙傝€?`deploy/scripts/lib/blake3seg.mjs`銆傛柟妗堬細`BLAKE3(BLAKE3(seg0)||...)`锛?MB 鍒嗙墖锛?*鈮?b3sum**銆?2. **涓ょ骇鍐呭瓨缂撳瓨**锛歚server/src/lib/segmentCache.ts`锛堟鏁版嵁 LRU + 娈靛搱甯岀紦瀛橈紝`HASH_CACHE_MB`锛夈€?3. **MinIO 鍗曠洏浼樺寲**锛歞ocker-compose 榛樿鍗曠洏鍛藉悕鍗凤紙4 鐩樼籂鍒犵爜浠呭鍧楃嫭绔嬬墿鐞嗙洏鎵嶆湁鎰忎箟锛夈€?4. **QA 鍏ㄥ姛鑳芥祴璇曪紙73/73 鍏ㄧ豢锛?*锛氳瑙?`docs/QA-娴嬭瘯鎶ュ憡.md`銆?5. **鏁版嵁搴撴煡璇紭鍖?*锛歱g_trgm GIN 绱㈠紩锛坄idx_files_name_trgm`锛屽疄娴?5 涓囪 35ms鈫?ms锛?-49x锛?   + 鐩綍 path 鍓嶇紑 btree 绱㈠紩锛坄idx_directories_path_pattern`锛夛紝宸插浐鍖栧埌 `deploy/postgres/init/01-schema.sql`銆?6. **Redis 鐑偣缂撳瓨**锛堢敤鎴峰喅绛栵細涓?Redis 瀹瑰櫒 + 涓嶅仛鏉冮檺缂撳瓨锛夛細
   - `server/src/lib/cache.ts`锛歩oredis 灏佽锛圱TL/鍓嶇紑鍒犻櫎/闈欓粯闄嶇骇鈥斺€擱edis 涓嶅彲鐢ㄦ椂涓氬姟鐩存帴钀藉簱锛?   - 鐩綍鍒楄〃锛歚listDir` 浠呯紦瀛?items锛堟潈闄愬疄鏃舵牎楠岋級锛岄敭 `dir:{orgId}:{userId}:{dirId}`锛?*鍚?userId**锛?     鍒楄〃椤规惡甯︽寜鐢ㄦ埛 ACL 瑙ｆ瀽鐨勬潈闄愭憳瑕侊紝涓嶅彲璺ㄧ敤鎴峰叡浜級锛孴TL 30s
   - 鍐欐搷浣滀富鍔ㄥけ鏁堬細mkdir / rename / move / copy / deleteToTrash / restore / purge / completeUpload
     锛堝け鏁堟搷浣滅洰褰?+ 鐖剁洰褰?+ 瀛愭爲锛?   - 鍒嗕韩鍏冧俊鎭細`getShareMeta` 缂撳瓨闈欐€佸瓧娈碉紙瀵嗙爜/鏈夋晥鏈熶笂闄?鍚嶇О/鎵€鏈夎€咃級锛岄敭 `share:{token}`锛?     TTL 15s锛堟湁鍒版湡鏃堕棿鍒欑簿纭埌鍒版湡鏃跺埢锛夛紱璁块棶璁℃暟**涓嶇紦瀛?*锛堝疄鏃舵煡璇紝淇濊瘉娆℃暟涓婇檺绮剧‘锛夛紱
     `revokeShare` 绔嬪嵆澶辨晥
7. **娴嬭瘯涓彂鐜板苟淇鐨?6 涓棶棰橈紙鍏ㄩ儴宸查儴缃查獙璇侊級**锛?   | # | 绾у埆 | 闂 | 淇 |
   |---|---|---|---|
   | 1 | P1 | 鍓嶇涓婁紶浠诲姟 N虏 鑶ㄨ儉锛坆eforeUpload 浼犳暣鎵?fileList锛?| 閫愭枃浠跺叆闃燂紙web 宸查噸寤猴級 |
   | 2 | P1 | 骞跺彂鍚屽悕 complete 绔炴€?500锛圥G 浜嬪姟 aborted锛?| 鍐茬獊鍥炴粴鈫掓柊浜嬪姟閲嶈瘯 |
   | 3 | P2 | 瀛ゅ効姹犲瓨鍌ㄦ硠婕忥紙鐪熷疄涓婁紶姹犲壇鏈笉娓呯悊锛屽疄娴?1.65GB锛?| **缂撳瓨+GC 璁捐**锛氭睜淇濈暀 30 澶╋紙POOL_GC_DAYS锛変緵鍒犻櫎鍚庣浼狅紝姣忔棩 GC 娓呯悊瓒呮湡闆跺紩鐢ㄦ睜 |
   | 4 | P2 | 鏂囦欢鍚?URL 缂栫爜绌胯秺鏈嫤鎴紙%2F/%5C/%00/CRLF 娉ㄥ叆锛?| decode 鍚庝簩娆℃牎楠岋紙寰幆 3 杞級+ 鎺у埗瀛楃鎷︽埅 |
   | 5 | P3 | 棰勮鍝嶅簲 Content-Type 渚濊禆涓婁紶 mime锛坥ctet-stream 涓嶅綋锛?| 鎸夋墿灞曞悕寮哄埗 response-content-type锛圥REVIEW_MIME锛?|
   | 6 | P3 | 澶у璞″搱甯岃鍙栧苟鍙戜笉瓒筹紙3 璺級 | 鎻愬崌鑷?6 璺紙104鈫?29 MB/s锛?|
8. **nginx 鍙嶄唬鍔ㄦ€佽В鏋愶紙鏍规不 server 閲嶅缓鍚?502锛?*锛歚/api/` 鏀?`resolver 127.0.0.11` + 鍙橀噺
   `proxy_pass $backend`锛涘疄娴嬪己鍒?server 鎹?IP 鍚庢棤闇€閲嶅惎 web銆佲墹10s 鑷姩鎭㈠锛堣绗?7 鑺傦級銆?9. **鏁版嵁搴撶储寮曡ˉ鍏咃紙10 涓囪 files + 5 涓囪 dirs 瀹炴祴锛?*锛?   - 閰嶉缁熻锛氭柊澧?`idx_files_owner_size (owner_id, size_bytes)`锛?*涓嶅甫璋撹瘝**鈥斺€斿洖鏀剁珯鏂囦欢浠嶅崰鐢?     閰嶉锛屼笌"鍒犻櫎杩涘洖鏀剁珯涓嶆墸鍑忋€佸交搴曞垹闄ゆ墠鎵ｅ噺"璇箟涓€鑷达級锛屽疄娴?Index Only Scan 26.7ms 鈫?0.3ms锛垀88x锛?   - files 鐩綍鍒楄〃锛氬垹闄ゅ啑浣?`idx_files_dir`锛堣 `uq_files_dir_name (dir_id,name) WHERE is_deleted=false`
     閮ㄥ垎鍞竴绱㈠紩瀹屽叏瑕嗙洊锛歞ir 绛夊€?+ name 鎺掑簭 + 杞垹闄よ繃婊わ級锛屽疄娴?0.356ms 鈫?0.185ms
   - 鈶?鏂囦欢鍚嶆悳绱?`idx_files_name_trgm`锛堜笂杞凡寤猴級銆佲憿 鐩綍 path 鍓嶇紑
     `idx_directories_path_pattern`锛堜笂杞凡寤猴級缁?5 涓囪瀹炴祴纭鐢熸晥锛坆tree pattern 0.91ms锛?     鍓嶇紑鏌ヨ浼樹簬 GIN trgm鈥斺€擥IN 浠呭涓棿鍖归厤鏈夋晥鑰岃矾寰勬煡璇㈠叏鏄墠缂€锛?*涓嶅缓 GIN**锛?   - 鐢ㄦ埛鍘熺淇锛歚files(parent_id,...)` 涓嶅瓨鍦ㄨ鍒楋紙鐩綍褰掑睘涓?dir_id锛夛紱`size` 搴斾负 `size_bytes`
10. **鍥炴敹绔欒嚜鍔ㄦ竻鐞嗗畬鍠?*锛坄trash.service.ts` + `scheduler/index.ts`锛夛細
   - 鍘熷凡鍏峰锛氭瘡鏃ユ竻鐞?+ 30 澶╋紙TRASH_RETENTION_DAYS锛? 閫愪釜 MinIO 鍒犻櫎 + DB 纭垹闄?+ 鐩綍瀛愭爲娓呯悊
   - 鏈琛ラ綈锛?*瀹¤鐣欑棔**锛坄writeSystemAudit`锛氱郴缁熺骇浠诲姟鏃?HTTP 涓婁笅鏂囷紝鐩存帴 INSERT audit_logs锛?     `trash_purge_file`/`trash_purge_dir`锛宒etail 鍚?name/size/objectRemoved/retentionDays/subtreeFiles锛?   - **鏃堕棿浠庡噷鏅?2 鐐规敼涓哄噷鏅?3 鐐?*锛坄'0 3 * * *'`锛屼笌閰嶉閲嶇畻鍚屽垎閽燂紱瀵?used_bytes 鐨勫啓鍏ュ湪
     READ COMMITTED 涓嬩簰涓嶉樆濉烇紝鏋佺浜ゅ弶鐢辨鏃ラ噸绠楁牎姝ｏ級
   - 瀹炴祴锛?1 澶╁墠鏂囦欢/鐩綍琚竻锛圖B 琛?+ MinIO 瀵硅薄鍧囨秷澶便€乽sed_bytes 鎵ｅ噺銆佸璁?5 鏉★級銆?     29 澶╁墠鏂囦欢淇濈暀
11. **鍓嶇涓夊潡浼樺寲锛堥灞?/ 涓婁紶杩涘害 / 鍒楄〃浜や簰锛屾祻瑙堝櫒瀹炴祴锛?*锛?   - 棣栧睆锛氳矾鐢辩骇 React.lazy + Suspense锛? 涓〉闈㈢嫭绔?chunk 0.3-10KB锛夛紱`FilePreview` 鎳掑姞杞?     鈥斺€攑dfjs/xlsx/docx锛坧review chunk 874KB + pdf.worker 1.3MB锛変笉鍐嶈繘棣栧睆锛沬ndex.html 鍔?boot-splash
     鍗犱綅銆傞灞?JS 绾﹀噺 840KB+
   - 涓婁紶杩涘害锛歚fileHash` 鏀寔鍒嗙墖杩涘害鍥炶皟锛堝ぇ鏂囦欢鍝堝笇闃舵鏄剧ず鐪熷疄杩涘害锛夛紱闃熷垪鏄剧ず瀹炴椂閫熺巼
     锛坕nterval 宸垎锛夛紱鍏ㄩ儴鎴愬姛 2.5s 鍚庤嚜鍔ㄦ敹璧?   - 鍒楄〃浜や簰锛氭湰鍦板嵆鏃惰繃婊わ紙杈撳叆鍗崇瓫锛屼笉璋冨悗绔級锛涘悕绉?澶у皬/鏃堕棿鍒楁帓搴忥紙鐐瑰嚮鍒楀ご锛夛紱
     澶х洰褰曪紙>400 椤癸級鑷姩鍚敤 rc-table 铏氭嫙婊氬姩锛坰croll.y 蹇呴』涓?*鏁板瓧**锛屽瓧绗︿覆 calc 浼氳嚧
     body 涓嶆覆鏌擄級锛涜繃婊ゅ悗鏃犳晥閫夋嫨閿嚜鍔ㄥ墧闄?   - 椤烘墜淇锛歛ntd `destroyOnClose`鈫抈destroyOnHidden`锛? 澶勶級銆丼pin tip nest 鐢ㄦ硶锛堟秷鎺у埗鍙拌鍛婏級
   - 瀹炴祴锛?00 鏂囦欢鐩綍 DOM 浠呮覆鏌?12 琛屻€佹粴鍔ㄥ埌搴曞彲瑙?doc_0500锛涜繃婊?1 琛屽懡涓紱鎺掑簭鍗?闄嶅簭姝ｇ‘锛?     鍝堝笇闃舵鏍囩鍑虹幇锛涢槦鍒楄嚜鍔ㄦ敹璧凤紱鏃犳帶鍒跺彴閿欒
12. **鐩戞帶鍛婅锛圧edis 鍐呭瓨 / 缂撳瓨鍛戒腑鐜?/ 娓呯悊浠诲姟鐘舵€侊級**锛?   - `monitor.service.ts`锛歚recordJobRun`锛坰cheduler 姣忎换鍔¤褰?monitor_job_runs锛夈€?     `runMonitorCheck`锛堟瘡 5 鍒嗛挓锛孧ONITOR_CHECK_CRON锛夛細Redis INFO 閲囬泦鍐呭瓨/鍛戒腑鐜囥€?     浠诲姟鍋滄粸璇勪及锛堟瘡鏃ヤ换鍔?26h / 姣忓皬鏃?2h 鏃犳垚鍔熷嵆鍛婅锛涙寔缁け璐ヤ篃鍛婅锛涜〃绌?= 璋冨害鍣ㄦ湭杩愯锛?   - 鍛婅鎸佷箙鍖栵細`monitor_alerts`锛堝悓 metric 鍘婚噸锛屾仮澶嶈嚜鍔ㄧ疆 inactive锛沗scheduler_not_running` 鍏ㄨ〃鍒ゆ椿锛?   - 绔偣锛歚/api/health` 闄勫姞 monitor 鎽樿锛堣鍐呭瓨缂撳瓨锛屾棤楂橀 Redis 璋冪敤锛夛紱
     `/api/monitor/status`锛堢櫥褰曪級銆乣/api/monitor/check`锛堢鐞嗗憳鎵嬪姩瑙﹀彂锛?   - 閰嶇疆锛歁ONITOR_REDIS_MEM_PCT(80)銆丮ONITOR_HITRATE_MIN_SAMPLE(200)銆丮ONITOR_CHECK_CRON
   - 瀹炴祴锛歳edis maxmemory 璋冭嚦 1MB 鈫?critical 鍛婅 鈫?鎭㈠ 256MB 鑷姩瑙ｉ櫎锛泂hare_cleanup 璁板綍
     鏀?3 澶╁墠 鈫?job_stale critical 鈫?鎭㈠瑙ｉ櫎锛沺ool_gc 鎸佺画澶辫触 鈫?鍛婅锛涘仴搴风姸鎬佷笅 0 鍛婅
13. **鍛婅閫氱煡娓犻亾锛堥拤閽?/ 浼佷笟寰俊 / 閭欢 / 閫氱敤 webhook锛?*锛?   - `lib/notify.ts`锛氬憡璀?*棣栨瑙﹀彂**锛坮aised锛変笌**鎭㈠**锛坮esolved锛夋椂閫氱煡锛屾寔缁憡璀︿笉閲嶅锛?     娓犻亾鏈厤缃嵆璺宠繃銆佸彲澶氶€夊悓鏃跺彂銆佸け璐ヤ粎璁版棩蹇椾笉褰卞搷涓绘祦绋?   - 閽夐拤鏈哄櫒浜猴紙markdown锛屾敮鎸佸姞绛?secret锛夈€佷紒涓氬井淇℃満鍣ㄤ汉锛坢arkdown锛夈€丼MTP 閭欢锛坣odemailer锛?     鏂颁緷璧栵級銆侀€氱敤 webhook锛圥OST JSON 浜嬩欢鏁扮粍锛?   - 閰嶇疆锛歚ALERT_DINGTALK_WEBHOOK/SECRET`銆乣ALERT_WECOM_WEBHOOK`銆乣ALERT_WEBHOOK_URL`銆?     `ALERT_SMTP_HOST/PORT/SECURE/USER/PASS`銆乣ALERT_MAIL_FROM/TO`
   - 瀹炴祴锛堟湰鍦版帴鏀跺櫒绔埌绔級锛氬憡璀?+ 鎭㈠涓ゆ柟鍚?脳 4 娓犻亾鍏ㄩ儴閫佽揪锛宲ayload 鏍煎紡绗﹀悎鍚勫钩鍙拌鑼?     锛堥拤閽?浼佸井 markdown銆亀ebhook 浜嬩欢鏁扮粍銆侀偖浠?quoted-printable锛?   - 娉ㄦ剰锛氫慨鏀?.env 鍚庨噸寤哄墠鍏?`docker compose config` 鏍￠獙锛?env 涓?娉ㄩ噴涓庤祴鍊煎悓琛?鏄」鐩?     鍘熸湁椋庢牸锛堣祴鍊艰娉ㄩ噴銆侀潬 compose 榛樿鍏滃簳锛夛紝鍕胯鏀?14. **鎬ц兘娓呭崟閫愰」鏍告煡涓庤ˉ榻愶紙璺敱鎳掑姞杞?gzip/杩涘害鏉?铏氭嫙婊氬姩/鍒嗛〉/缂╃暐鍥撅級**锛?   - 鉁?璺敱鎳掑姞杞斤紙瀹屾垚椤?11锛夈€佲渽 gzip锛坣ginx 宸查厤缃紝瀹炴祴 Content-Encoding: gzip 鐢熸晥锛夈€?     鉁?涓婁紶杩涘害鏉★紙瀹屾垚椤?11锛夈€佲渽 铏氭嫙婊氬姩娓叉煋锛堝畬鎴愰」 11锛?   - 鈶?缁勪欢鎸夐渶鍔犺浇锛氳ˉ ShareModal/PermissionModal/VersionModal/MoveModal/UploadQueue 鈫?React.lazy
     锛團ilePreview 宸叉噿鍔犺浇锛涘脊绐楀眬閮?Suspense 閬垮厤鏁撮〉 fallback锛?   - 鈶?**鏈嶅姟绔垎椤?*锛堟鍓嶈櫄鎷熸粴鍔ㄥ彧瑙ｅ喅娓叉煋銆乴istDir 浠嶅叏閲忚繑鍥?10 涓囨潯锛夛細listDir 鍔?     offset/limit锛堥粯璁?500锛屼笂闄?5000锛? total/hasMore锛?*缂撳瓨浠呴椤?*锛坥ffset=0锛夛紝鍐欐搷浣滃け鏁堢収鏃э紱
     鍓嶇"鍔犺浇鏇村"鎸夐挳锛堝凡鏄剧ず x / total锛夈€傚疄娴?1200 鏂囦欢鐩綍锛?00/500/200 涓夐〉銆乭asMore 姝ｇ‘銆?     鎺掑簭绋冲畾锛坧gfile_0001鈫?501鈫?001锛?   - 鈶?**鍥剧墖缂╃暐鍥炬噿鍔犺浇**锛堟鍓嶅垪琛ㄥ彧鏈夊浘鏍囷級锛氭柊澧?ThumbImg 缁勪欢鈥斺€斿浘鐗囨枃浠讹紙鎵╁睍鍚嶅垽鏂級
     鍦ㄥ悕绉板垪鏄剧ず缂╃暐鍥撅紝IntersectionObserver 杩涘叆瑙嗗彛鎵嶈姹傞瑙?URL锛坮ootMargin 200px 棰勫姞杞斤級锛?     URL 鎸夋枃浠剁紦瀛橈紙55min TTL 闃茬鍚嶈繃鏈燂級锛涘疄娴?canvas 鐢熸垚 PNG 涓婁紶鍚庡垪琛ㄦ覆鏌?<img>
     naturalWidth>0銆乸review API 200
   - 宸茬煡杈圭晫锛氬垎椤靛悗鏂颁笂浼犳枃浠惰嫢鎸?name 鎺掑湪澶х洰褰曢椤典箣澶栵紝闇€"鍔犺浇鏇村"/杩囨护鏌ョ湅锛堥椤靛埛鏂帮級
   - 鍓嶇涓诲寘杩涗竴姝ョ缉灏忥細寮圭獥缁勪欢绉诲嚭锛堥灞?index chunk 绾?76KB 鈫?鏇村皬锛?15. **鍒嗕韩椤甸潰鐙珛锛堟棤鐧诲綍鎬佹煡鐪嬪垎浜摼鎺ワ級**锛?   - 鏋舵瀯鏈凡鏀寔锛歚/share/:token` 鍦?RequireAuth 涔嬪鐙珛璺敱锛涘垎浜?API
     锛坢eta/verify/download/list锛夊湪鍏?CSRF 鍏紑缁?   - 瀹炴祴锛堟棤鐥曟祻瑙堝櫒涓婁笅鏂囷紝鏃犱换浣?cookie/token锛夛細鍗曟枃浠跺垎浜紙鎵撳紑/鏂囦欢鍚?涓嬭浇锛夈€?     鐩綍鍒嗕韩锛堟墦寮€/鐩綍鍚?鍒楄〃/鏂囦欢鍙锛夊叏閮ㄩ€氳繃锛屾棤 401銆佹棤鎺у埗鍙伴敊璇?   - 淇涓€涓竟鐣岋細鍒嗕韩鐩綍鍚浘鐗囨枃浠舵椂锛屽垪琛ㄥ鐢ㄧ殑 FileTable 浼氭覆鏌?ThumbImg 鈫?     璋冪敤闇€鐧诲綍鐨?preview API 鈫?鏃犵櫥褰?401 + 鎺у埗鍙板櫔闊炽€傛柊澧?`showThumbs` 寮€鍏?     锛堥粯璁?true锛夛紝鍒嗕韩椤典紶 false锛涘垎浜〉 document.title 璁句负鍒嗕韩鍚?   - 楠岃瘉锛氫慨澶嶅悗鍚浘鐗囩殑鐩綍鍒嗕韩鏃?401銆佺缉鐣ュ浘涓嶅啀瑙﹀彂闇€鐧诲綍璇锋眰
16. **绉诲姩绔€傞厤锛堝搷搴斿紡锛?75px 瑙嗗彛瀹炴祴 14/14锛?*锛?   - `useMediaQuery` hook锛坄useIsMobile` <768px锛?   - MainLayout锛歋ider `breakpoint="md"` + `collapsedWidth={0}`锛堢Щ鍔ㄧ鑷姩鎶樺彔涓烘诞灞傦紝
     姹夊牎鎸夐挳灞曞紑 + 鐐瑰嚮鑿滃崟椤硅嚜鍔ㄦ敹璧?+ 閬僵锛夛紱Header 鎼滅储妗嗗叏瀹姐€佺敤鎴峰悕/瑙掕壊绉诲姩绔殣钘?   - FileTable锛氱Щ鍔ㄧ闅愯棌"鎵€鏈夎€?鏇存柊鏃堕棿"鍒楋紙淇濈暀鍚嶇О+澶у皬+鎿嶄綔锛夛紝铏氭嫙婊氬姩鍒楀/scroll.x 鍔ㄦ€?   - FileBrowserPage锛氳繃婊ゆ绉诲姩绔叏瀹斤紱UploadQueue锛欴rawer 绉诲姩绔叏瀹斤紙100%锛?   - ShareViewPage锛氬崱鐗?`width:100% + maxWidth`锛汱oginPage锛氱櫥褰曞崱 `calc(100vw-32px)`
   - styles.css 鍔?`@media (max-width:768px)`锛堢櫥褰曞崱/鍐呭 padding/闃熷垪绱у噾锛?   - 瀹炴祴锛氱櫥褰曞崱 343px 涓嶈秴瑙嗗彛銆佷晶杈规爮鎶樺彔 1px銆佹眽鍫″睍寮€ 220px銆佽〃鏍煎垪绮剧畝銆佹棤妯悜婊氬姩銆?     涓婁紶闃熷垪鍏ㄥ 375銆佸垎浜崱鐗囪嚜閫傚簲銆佹闈?1440 鍥炲綊锛堝垪淇濈暀锛?17. **鎬ц兘鍘嬫祴锛坘6锛?00 骞跺彂 脳 30s锛変笌 cluster 澶氳繘绋嬩紭鍖?*锛?   - 鑴氭湰锛歚deploy/scripts/k6/{health,static,api-list}.js`锛坘6 瀹瑰櫒 join 瀹瑰櫒缃戠粶鍘嬫祴 nginx锛?   - 瀹炴祴鍩虹嚎锛? 鏍?VM锛夛細
     | 鍦烘櫙 | 鍗曡繘绋?| cluster 4 worker | 璇存槑 |
     |---|---|---|---|
     | health锛圖B+MinIO 鎺㈡祴锛?| 577 RPS / P95 1.16s | 665 RPS / P95 1.02s | 澶栭儴渚濊禆搴忓垪鍖栵紝鎻愬崌鏈夐檺 |
     | 闈欐€佽祫婧愶紙nginx gzip锛?| 6774 RPS / P95 141ms | 鈥?| 鏈€寮猴紝涓?server 鏃犲叧 |
     | 鐧诲綍鎬佸垪鐩綍锛圝WT+DB+Redis锛?| 255 RPS / P95 3.78s | **351 RPS / P95 2.19s** | +38% / -42% |
     鍏ㄩ儴 0 澶辫触锛?00 骞跺彂涓嬫棤閿欒鍝嶅簲锛?   - 鐡堕瀹氫綅锛歞ocker stats 瀹炴祴 server CPU 鍗曡繘绋?~120%锛堝崟鏍搁ケ鍜岋級銆丳G/Redis 浣庤礋杞?     鈫?**cluster 澶氳繘绋?*锛坄index.ts`锛氫富杩涚▼寮曞 + scheduler 鍗曞疄渚?+ 4 worker 鍏变韩绔彛锛?     worker 宕╂簝鑷姩鎷夎捣锛沗PG_POOL_MAX` 姣?worker 鍧囧垎锛沗WEB_CONCURRENCY` 鍙厤锛? = 鍏抽棴锛?   - cluster 鍚?worker CPU ~295%锛?/4 鏍告弧锛夆€斺€旂摱棰堝凡鍒?4 鏍?VM CPU 涓婇檺锛?     鏇撮珮鍚炲悙闇€鏇村鏍告垨鍑忓皯姣忚姹?CPU锛圝WT 楠岃瘉 + JSON 搴忓垪鍖栵級
   - 鍥炲綊锛氱櫥褰?鍒楃洰褰?涓婁紶/涓嬭浇/鍒犻櫎鍏ㄩ儴閫氳繃锛泂cheduler 浠呬富杩涚▼鎵ц锛堟棤閲嶅浠诲姟锛?18. **蹇樿瀵嗙爜锛堥偖绠?/ 鐭俊鎵惧洖锛?*锛?   - 鍚庣 `password-reset.service.ts`锛氫粎鏈湴璐﹀彿锛圠DAP 鐢卞煙鍐呯鐞嗭級锛? 浣嶉獙璇佺爜 10 鍒嗛挓鏈夋晥銆?     鏈€澶?5 娆″皾璇曘€佹瘡璐﹀彿 1 灏忔椂 5 娆″彂閫?+ 60s 鍐峰嵈銆両P 闄愭祦锛涚粺涓€妯＄硦鍝嶅簲锛堜笉娉勯湶璐﹀彿
     鏄惁瀛樺湪锛夛紱閲嶇疆鍚庡悐閿€鍏ㄩ儴浼氳瘽
   - 閫氶亾锛氶偖绠憋紙SMTP锛孯ESET_MAIL_*锛? 鐭俊锛堣嚜寤虹綉鍏?webhook锛孯ESET_SMS_WEBHOOK POST
     {phone, code}锛夛紱鏈厤缃€氶亾鏃跺墠绔彁绀?鑱旂郴绠＄悊鍛?
   - 琛?`password_reset_codes`锛堢储寮?+ 姣忔棩娓呯悊淇濈暀 7 澶╋級锛涘璁?`password_reset`
   - 鍓嶇锛歚/forgot-password` 鐙珛椤碉紙涓夋锛氳处鍙?閫氶亾 -> 楠岃瘉鐮?鏂板瘑鐮?-> 瀹屾垚锛夛紝鐧诲綍椤?     "蹇樿瀵嗙爜锛?鍏ュ彛锛涢€氶亾鍙敤鎬х敱 `/api/auth/password-reset/channels` 椹卞姩
   - 瀹炴祴绔埌绔紙鏈湴 SMTP 鎺ユ敹鍣級锛氬彂鐮?-> 閭欢鏀跺埌 6 浣嶇爜锛坆ase64 姝ｆ枃瑙ｇ爜锛?> 閿欒鐮?400 ->
     姝ｇ‘鐮侀噸缃?-> 鏂板瘑鐮佺櫥褰曟垚鍔?-> 楠岃瘉鐮佷竴娆℃€э紙澶嶇敤 400锛?> 鍘熷瘑鐮佸け鏁堬紱admin 瀵嗙爜宸叉仮澶?   - 鐢熶骇閰嶇疆锛?env 濉?`RESET_MAIL_HOST/PORT/SECURE/USER/PASS/FROM`锛堟垨 `RESET_SMS_WEBHOOK`锛夊悗
     閲嶅缓 server 鍗崇敓鏁堬紱鐢ㄦ埛闇€鍦ㄧ鐞嗗彴缁存姢 email/phone 瀛楁
19. **娉ㄥ唽/鐧诲綍瀹夊叏澧炲己锛堟牳蹇?8 椤癸紝绔埌绔疄娴?41 椤瑰叏缁匡級**锛?   - **鑷姪娉ㄥ唽** `/register`锛氶偖绠?鎵嬫満楠岃瘉鐮侊紙`verification_codes` 琛紝闄愭祦 1h5 娆?60s 鍐峰嵈銆?     涓€娆℃€с€? 娆″皾璇曪級+ 绠楁湳 CAPTCHA锛?*Redis 瀛樺偍**鈥斺€攃luster 澶?worker 鍏变韩锛岃繘绋嬪唴瀛樹細璺?     worker 澶辨晥锛? 瀵嗙爜寮哄害锛堚墺8 浣嶅惈瀛楁瘝鏁板瓧锛? 鐢ㄦ埛鍗忚蹇呴€夛紱閲嶅娉ㄥ唽/鏈悓鎰忓崗璁鎷?   - **澶氭柟寮忕櫥褰?*锛氳处鍙?閭/鎵嬫満鍙凤紙`username OR email OR phone`锛夛紱LDAP 璧板煙璁よ瘉
   - **璐﹀彿閿佸畾**锛氳繛缁?5 娆″け璐ラ攣瀹?30 鍒嗛挓锛坄failed_attempts/locked_until`锛夛紝鍒版湡鑷姩瑙ｉ攣
   - **2FA锛圱OTP锛?*锛歴peakeasy + qrcode锛堟柊渚濊禆锛夛紱璁剧疆鎵爜缁戝畾 鈫?鐧诲綍瀵嗙爜鍚庡彂鎸戞垬浠ょ墝
     锛? 鍒嗛挓 JWT锛夆啋 鏍￠獙鍔ㄦ€佺爜瀹屾垚鐧诲綍锛坄finishAuth` 闇€璺宠繃 2FA 鍒嗘敮鍚﹀垯浜屾杩斿洖鎸戞垬鈥斺€斿凡淇級锛?     鍏抽棴闇€鍔ㄦ€佺爜+瀵嗙爜锛沗window:1` 瀹瑰繊鏃堕挓鍋忓樊
   - **瀵嗙爜鎵惧洖鍗囩骇**锛氶獙璇佺爜 + **閲嶇疆閾炬帴**锛堜竴娆℃€с€?0 鍒嗛挓銆乣reset-password?token=` 椤碉級锛?     閲嶇疆鍚庡悐閿€鍏ㄩ儴浼氳瘽寮哄埗閲嶆柊鐧诲綍
   - **瀵嗙爜鍘嗗彶**锛歚password_history` 琛ㄤ繚鐣欐渶杩?5 鏉★紝鏀瑰瘑/閲嶇疆绂侀噸澶嶄娇鐢?   - **璁惧绠＄悊**锛歚/api/auth/sessions` 鍒楄〃锛堝惈褰撳墠鏍囪锛? 韪笅绾匡紙鍚婇攢浼氳瘽锛?   - **寮傚父鐧诲綍妫€娴?*锛氱櫥褰曟椂瀵规瘮鏈€杩戜細璇?IP/UA 鍙樺寲 鈫?`risk` 鏍囪 + 鍓嶇鎻愮ず
     锛堟棤 IP 鍦扮悊搴擄紝鐢ㄨ澶囩壒寰佽繎浼硷紱寮傚湴鍦扮悊搴?鏁版嵁瀵煎嚭/90 澶╁己鍒舵敼瀵嗗悗缃級
   - 瀹炴祴锛氬畨鍏ㄦ祴璇?1锛堟敞鍐?澶氭柟寮?閿佸畾/璁惧锛?4 椤广€佸畨鍏ㄦ祴璇?2锛?FA/閲嶇疆閾炬帴/鍘嗗彶锛?6 椤广€?     鍓嶇娓叉煋 11 椤癸紝鍏ㄩ儴閫氳繃
20. **鎵归噺鎿嶄綔鍒嗘壒淇锛堝洖鏀剁珯鍏ㄩ€変竴娆℃€у交搴曞垹闄わ級**锛?   - 鏍瑰洜锛氭壒閲忔帴鍙?`targets` 鍗曟涓婇檺 100锛堝悗绔槻婊ョ敤锛夛紝鍥炴敹绔?>100 椤瑰叏閫変竴娆℃€ф彁浜よ zod
     鎷掔粷锛?00锛夆啋 鍙兘鍗曚釜鍒犻櫎
   - 淇锛氬墠绔?*鍒嗘壒涓茶**锛堟瘡鎵?鈮?00锛夆€斺€擿TrashPage` 鎭㈠/褰诲簳鍒犻櫎銆乣FileBrowserPage`
     鍒犻櫎/绉诲姩/澶嶅埗锛坄chunked`/`chunkedTargets`锛夛紱鎵归噺 `onOk` 琛?try/catch锛堝け璐ユ彁绀?+ 鍒锋柊
     鍒楄〃锛岄槻纭寮圭獥鍗℃鏃犲弽棣堬級
   - 瀹炴祴锛堟祻瑙堝櫒 e2e `e2e/_trash-batch-full.mjs`锛夛細API 閫?105 鐩綍锛?100锛夆啋 鏂囦欢椤靛叏閫?     105 琛?鈫?Popconfirm+Modal 涓ょ骇纭鏄剧ず 105 鈫?鍒嗘壒鍒犻櫎 鈫?鍥炴敹绔?105 椤?鈫?鍏ㄩ€夊交搴曞垹闄?     锛堢‘璁ゅ脊绐?105 椤癸級鈫?鍒嗘壒 purge 鈫?娓呯┖锛屽叏绋嬫棤鎺у埗鍙伴敊璇?21. **浣撻獙浼樺寲 v1.0.10锛堜唬鐮佸鏌?32 椤?+ 娴忚鍣ㄥ疄娴嬫暣鏀癸級**锛氳瑙?CHANGELOG v1.0.10銆?    - 鏍稿績锛歛pi 灞傜粺涓€ 30s 瓒呮椂 + 缃戠粶閿欒涓枃褰掍竴鍖栵紙鏍瑰洜锛夛紱瀵嗙爜寮哄害鍓嶇涓庡悗绔畬鍏ㄤ竴鑷?      锛坄web/src/utils/password.ts` 澶嶇敤 4 澶勶級锛涗笂浼?鏂板缓鎸夊啓鏉冮檺绂佺敤锛涙壒閲忓垹闄ゅ崟娆＄‘璁わ紱
      涓婁紶瀹屾垚姹囨€婚€氱煡锛汳oveModal/鐗堟湰鍥炴粴/鏉冮檺鍒犻櫎闃查噸涓庡閿?    - 鍒嗕韩椤碉細鐩綍鍒嗕韩闈㈠寘灞戯紙鍚庣杩斿洖瀛愭爲鍐呯鍏堥摼锛屽彲鐐瑰嚮杩斿洖涓婄骇锛? 鐩綍鍐呮枃浠跺彲涓嬭浇
      锛坉ownloadShare 鏀寔 fileId锛? 缃戠粶閿欒涓?鍒嗕韩涓嶅瓨鍦?鍖哄垎
    - 瀹夊叏鎿嶄綔纭锛氬叧闂?2FA / 涓嬬嚎璁惧浜屾纭锛涙敞鍐岄〉楠岃瘉鐮?60s 鍊掕鏃躲€丆APTCHA 澶辫触閲嶈瘯銆?      鍗忚閾炬帴 stopPropagation
    - 瀹炴祴锛歚e2e/_ux-assert.mjs`锛?8 椤癸級+ `e2e/_share-ux.mjs`锛?0 椤癸級鍏ㄧ豢
22. **涓婁紶鎬ц兘浼樺寲 v1.0.11锛堢敤鎴峰疄娴?6 鏂囦欢 2.4s/涓?鈫?璇锋眰绾у墫鏋愰┍鍔級**锛?   - 鏍瑰洜锛氫笂浼犺姹傛湰韬粎 100-300ms/鏂囦欢锛涙氮璐瑰湪 鈶?鍓嶇姣忎换鍔″畬鎴愰兘鍒锋柊鍒楄〃
     锛? 鏂囦欢 鈫?6 娆?GET 瀵癸紝~1.8s锛夆憽 BLAKE3 WASM 棣栨鍔犺浇锛垀100ms+锛夆憿 completeUpload
     閲嶅 statObject锛? 娆?MinIO 寰€杩旓級
   - 淇锛氫笂浼犲畬鎴愬埛鏂?*闃叉姈鍚堝苟**锛?00ms 绐楀彛涓€娆★級锛沗warmupHash()` 椤甸潰鍔犺浇鍚庨鐑?WASM锛?     completeUpload 鍚堝苟涓ゆ statObject 涓轰竴娆?   - 瀹炴祴锛?脳2KB 鍏ㄦ柊鍐呭锛夛細璇锋眰闃舵 ~1.3s 鍏ㄩ儴瀹屾垚 + 鍒楄〃鍒锋柊浠?1 娆★紙鍘?6 娆★級锛?     绉掍紶鍦烘櫙 init <500ms
   - 娉ㄦ剰锛氱敤鎴峰凡涓婁紶鐪熷疄鏁版嵁锛堢害 950 娲昏穬鏂囦欢锛孭ython 椤圭洰鐩綍鏍戯級锛?*鍕挎竻鐞?*锛?     娴嬭瘯娈嬬暀鍙厑璁告竻鐞?`鑰楁椂娴嬮噺-*`/`fresh-*`/`perf-*`/`娴忚鍣ㄤ笂浼犺€楁椂.bin` 绫诲懡鍚?23. **澶ф枃浠跺す涓婁紶瀹炴祴涓庝紭鍖?v1.0.12锛?1k 鏂囦欢/1.37GB 瀹炴祴椹卞姩锛?*锛?   - 瀹炴祴锛歚E:\python\Projectpython_N\history_lottery`锛?1380 鏂囦欢/3195 鐩綍/1.37GB锛屽惈 711MB 澶ф枃浠讹級
   - 鐡堕瀹氫綅锛堟祻瑙堝櫒璇锋眰绾?+ 椤靛唴 fetch 瀵圭収锛夛細涓婁紶璇锋眰鏈韩蹇紙椤靛唴 fetch 27.9 鏂囦欢/s銆?     node 17.5/s锛夛紝鎱㈠湪 鈶?鐩綍閫愮粍涓茶 mkdir 鈶?鏂囦欢澶逛竴娆℃€?addFiles 鍙惎鍔?1 骞跺彂
     鈶?涓婁紶闃熷垪鍏ㄩ噺娓叉煋 + 姣忎换鍔＄姸鎬佸彉鍖栬Е鍙?O(n) React 閲嶆覆鏌擄紙**涓诲洜**锛?1k 浠诲姟鏃?     涓荤嚎绋嬭娓叉煋楗ラタ锛?00 鏂囦欢 136s 鍙畬鎴?26 涓級鈶?zustand 鏁扮粍 map O(n) 鏇存柊
   - 淇锛氱洰褰?*鎸夋繁搴﹀垎灞傚苟琛?mkdir**锛堥檺娴?12锛夛紱addFiles **寰幆濉弧骞跺彂妲?*锛堝皬鏂囦欢 6/澶ф枃浠?2锛夛紱
     闃熷垪**娓叉煋瑁佸壀**锛堜粎 200 鏉★級+ **1s 杞蹇収**锛堟牴娌伙細500 鏂囦欢 41s 鍏ㄥ畬鎴愶紝~12 鏂囦欢/s锛夛紱
     tasks 鏀?**Map 瀛樺偍 O(1) 鏇存柊** + FIFO 璋冨害 + 骞跺彂涓婇檺缂撳瓨
   - 鏈€缁堝疄娴嬶細500 鏂囦欢 41s锛?2/s锛夛紱**21380 鏂囦欢鍏ㄩ噺瀹炴祴瀹屾垚锛?1363 钀藉簱锛?9.9%锛夛紝
     3196 鐩綍 3s 寤洪綈锛? 澶辫触锛屾€昏€楁椂绾?100 鍒嗛挓锛垀4.3 鏂囦欢/s 绋冲畾锛?*锛?     17 涓湭钀藉簱涓?3 灏忔椂 token 杩囨湡鍓嶅熬娈典腑鏂紙鍓嶇鏃犺法浼氳瘽鏂偣缁紶锛?   - 宸茬煡杈圭晫锛氬埛鏂伴〉闈?闀夸細璇?token 杩囨湡浼氫腑鏂墠绔┍鍔ㄧ殑涓婁紶锛堝悗缁彲鍋氭湇鍔＄鏂偣缁紶锛?24. **Token 杩囨湡娌荤悊 v1.0.13锛?1k 瀹炴祴 17 鏂囦欢闈欓粯涓㈠け 鈫?闆堕潤榛樺け璐ワ級**锛?   - 绗竴杞富鍔ㄧ画鏈燂細`utils/token-refresh.ts` 瑙ｇ爜 JWT exp + 60s 瀹氭椂鍣紙鈮?0min 闃堝€间富鍔ㄥ埛鏂帮紝
     瑕嗙洊 30 鍒嗛挓 access_token 鏈夋晥鏈燂級+ 骞跺彂閿?+ 5s 鍒锋柊瓒呮椂 + 鎸囨暟閫€閬匡紙1s/2s/4s/8s 闃?429锛?     + 60s 鏈€灏忛棿闅旓紙401 绾犻敊 force 鏃犺闂撮殧锛夛紱`hooks/useVisibilityCheck.ts` 鍒囧墠鍙版娴?   - 绗簩杞?401 绾犻敊锛歚api/client.ts` 鍒锋柊澶辫触涓嶈烦鐧诲綍锛屾敼**鏆傚仠闃熷垪**锛沗store/upload.ts`
     鐘舵€佹満鍔?`auth-failed`锛坧auseForAuth/resumeAuth锛屾仮澶嶄笉閲嶇疆宸蹭紶杩涘害锛夛紱
     `components/UploadResumeButton.tsx` 鎭㈠鍏ュ彛锛汱oginPage 鐧诲綍鍚庤嚜鍔ㄦ仮澶嶏紱
     `utils/metrics.ts` 鍩嬬偣 interrupt_reason
   - E2E `e2e/_token-e2e.mjs`锛歍C-01 鍒锋柊閲嶈瘯 / TC-02 鏆傚仠鐘舵€佹満 / TC-03 鎭㈠ / TC-05 429 閫€閬?鍏ㄧ豢
   - 绗笁杞柇鐐圭画浼狅紙IndexedDB + 鏈嶅姟绔垎鐗囨煡璇級涓?v1.1.x 瑙勫垝锛屾湭瀹炴柦
25. **瀹屾暣鏂偣缁紶 v1.1.0锛堢涓夎疆钀藉湴锛?*锛?   - IndexedDB 鎸佷箙鍖栵紙`utils/resume-store.ts`锛夛細sessionId/partsEtag + 灏忔枃浠?File 寮曠敤
   - 鏈嶅姟绔垎鐗囩櫥璁帮細`POST /upload/parts-report` + `GET /upload/parts`
     锛坲pload_sessions.uploaded_parts 鍒楁縺娲伙級
   - 鑷姩鎭㈠锛坄hooks/useAutoResume.ts`锛夛細鍒锋柊鍚庡皬鏂囦欢鑷姩鍏ラ槦缁紶锛涘ぇ鏂囦欢閲嶉€夌画浼?   - 瀹炴祴锛?0MB 鍒嗙墖涓柇 鈫?璁板綍淇濈暀 鈫?閲嶉€夌画浼犲畬鎴愶紱鏈嶅姟绔?uploaded_parts {1,2} 鉁?   - 娴嬭瘯鑴氭湰锛歚e2e/_resume-e2e.mjs`銆乣e2e/_resume-real.mjs`
   - **v1.1.1 瀹℃煡鍔犲浐**锛欼ndexedDB 涓嶅彲鐢ㄩ檷绾?localStorage锛圫afari 绉佹湁妯″紡锛夛紱鎵归噺鍐欏悎骞?     锛?00ms锛岄槻楂橀浜嬪姟锛夛紱鏈嶅姟绔笂鎶ユ敼澧為噺锛堥槻鏁扮粍鑶ㄨ儉锛夛紱鎭㈠鍒嗘壒锛堥槻鏋佺闃诲锛夛紱
     鏈嶅姟绔竻鐞嗗懆鏈熺‘璁ゆ瘡鏃?02:30
   - **v1.1.2 婕忎紶鏍规不**锛?1k 涓婁紶 9 鏂囦欢婕忎紶锛坅nyio 瀛愭爲锛夊畾浣嶄负 **pump FIFO 闄堟棫蹇収绔炴€?*
     锛堜换鍔¤璺宠繃浠庢湭鎵ц锛屾棤 init 璁板綍锛泇1.0.12 鍚屾牱婕?17 涓級銆傛案涔呬慨姝ｏ細
     鈶?pump 鍐呭眰寰幆姣忔閲嶆柊 getState 鈶?`verifyAndBackfill` 涓婁紶瀹屾垚鏍￠獙+鑷姩琛ヤ紶銆?     楠岃瘉锛歛nyio 閲嶄紶 87 鏂囦欢 100%銆佹ā鎷熷垹闄も啋鑷姩琛ヤ紶銆?1k 瀵规瘮 0 婕忎紶 0 澶氫綑
   - **v1.1.3 鍥炴敹绔欐竻绌烘暟鎹涪澶憋細鏍瑰洜 + 鍏ㄩ噺鎭㈠ + purge 闃插尽鍔犲浐 + 娓呯┖鎬ц兘浼樺寲**锛?5:35 鐢ㄦ埛缃戦〉鍏ㄩ€?     鍒犻櫎 62 鐩爣锛?2799 椤瑰惈 21k 涓婁紶锛夆啋 娓呯┖鍥炴敹绔?鈫?files/directories 鍏ㄦ竻绌恒€?     鎭㈠锛歁inIO 鐗堟湰鎺у埗淇濈暀鍘嗗彶 PUT 鏁版嵁 鈫?鎾ら攢 19879 涓垹闄ゆ爣璁?鈫?瀵硅薄鍏ㄦ仮澶嶏紱
     audit_logs 閲嶅缓鐩綍鏍戯紙39519锛? 鏂囦欢锛?0955锛?3.7GB锛夆啋 鎶芥煡涓嬭浇瀛楄妭涓€鑷淬€?     淇锛歚purgeItems` 鐩綍/鏂囦欢鍒嗘敮琛?`is_deleted` 鏍￠獙锛堟椿璺冪洰鏍?purge 杩斿洖 count=0 鎷掔粷锛夈€?     鎬ц兘锛歚listTrash` 鍒嗛〉 + total锛涙柊澧?`POST /api/files/trash/empty` 娓呯┖鍥炴敹绔欎笓鐢ㄦ帴鍙?     锛堟湇鍔＄鎵归噺鍒犲璞?removeObjects + 鎵归噺鍒犺 ANY 鏁扮粍 + 鑱氬悎 quota锛夛紱鍓嶇銆屾竻绌哄洖鏀剁珯銆嶆寜閽€?     瀹炴祴娓呯┖ 1200 椤?7.7s锛堟鍓?844 鎵?脳 2s 鈮?28 鍒嗛挓锛夈€傜敤鎴风‘璁ゅ垹闄ゆ仮澶嶆暟鎹苟娓呯┖锛?     瀛ゅ効娈嬬暀涓€骞舵竻鐞?鈫?骞插噣鐘舵€侊紙2 鏍圭洰褰曘€? 鏂囦欢銆佸洖鏀剁珯 0锛夛紱鍘婚噸姹?4523 鏉?+ MinIO
     姹犲璞?21629 涓寜鐢ㄦ埛鎸囦护鍏ㄩ儴鍒犻櫎锛堝悗缁笂浼犻噸鏂版敞鍐屾睜锛夈€?     鎭㈠宸ュ叿锛歚e2e/_recover-*.mjs`锛汳inIO 鏁版嵁鍗峰浠斤細`N:\minio-data-backup-20260826`
   - 娴嬭瘯鑴氭湰锛歚e2e/_big-folder-upload.mjs`锛?1k 鍏ㄩ噺锛夈€乣_perf500.mjs`銆乣_inpage-fetch.mjs`銆?     `_server-throughput.mjs`銆乣_folder-conc.mjs`銆乣_single-timing.mjs`
   - **v1.1.4 浜у搧鍖?*锛氬敭鍓?浜や粯/婕旂ず鏂囨。锛坉ocs/08-10锛? README 浜у搧棣栭〉 + 涓€閿紨绀鸿剼鏈?   - **v1.1.5 涓婁紶浣撻獙淇锛堢敤鎴峰弽棣堬級**锛氬伓鍙戙€岃姹傚け璐ワ紝璇风◢鍚庨噸璇曘€嶁啋 鐬椂鏁呴殰鑷剤锛?     鏆傚仠/缁х画锛堝崟浠诲姟 + 鍏ㄩ€夋壒閲?+ 鍏ㄩ儴鏆傚仠/涓€閿叏閮ㄧ户缁級锛涗笂浼犻潰鏉挎敼涓轰笉閬尅椤甸潰鐨勬偓娴崱鐗囥€?     璇﹁ `CHANGELOG.md` v1.1.5 涓?`docs/upload-architecture.md` 绗?5 鑺傘€?     楠岃瘉锛歚node --import ./e2e/ts-register.mjs e2e/_upload-resilience.ts` 鈫?25/25 閫氳繃
     锛堝彈闄愮幆澧冩棤娉曡窇 esbuild/tsx 涓?Docker锛屾晠鐢?Node 鍘熺敓 TS 鍓ョ + 浼€?XHR/fetch 鍋氶€昏緫楠岃瘉锛?     椤哄甫淇 3 涓殣鎬х己闄凤細杩熷埌杩涘害瑕嗙洊宸茬粨绠楃姸鎬侊紙杩愯浠ょ墝锛夈€佽繜鍒板洖璋冨娲绘浼氳瘽锛坮ecordWrites锛夈€?     鏆傚仠鍚庣珛鍒荤户缁涓嶅埌鏂偣锛坒lushResumeWrites锛?   - **v1.1.6/v1.1.7 涓婁紶浠诲姟鍒楄〃甯搁┗**锛氫笉鍐嶈嚜鍔ㄩ殣钘?+ 椤舵爮鍥哄畾鍏ュ彛锛涙闈㈢鏀逛负**鍙充晶鍗犱綅甯搁┗鏍?*
     锛堜笉瑕嗙洊鏂囦欢鍒楄〃锛屽彲鏀惰捣涓?48px 缁嗘爮锛夛紝绉诲姩绔繚鎸佸簳閮ㄩ潰鏉?   - **v1.1.8 涓婁紶鍙潬鎬ф牴鍥犱慨澶嶏紙鐪熷疄娴忚鍣ㄥ鐜?+ 鏈嶅姟绔棩蹇楀畾浣嶏級**锛?     鈶?**骞跺彂鍝堝笇涓插彿锛圥0锛?*锛氬鎴风 BLAKE3 worker 姹犵敤銆屽垎鐗囧簭鍙枫€嶅綋璇锋眰 ID锛屽鏂囦欢骞跺彂鍝堝笇鏃?        浜掔浉 resolve 鈫?涓婃姤閿欒鍝堝笇 鈫?鏈嶅姟绔?400銆屾枃浠跺搱甯屾牎楠屽け璐ャ€嶁啋 鐣岄潰銆岃姹傚け璐ワ紝鐐归噸璇曞張鑳芥垚鍔熴€?        锛堚墹8MB 璧颁富绾跨▼鍘熷瓙鍝堝笇锛屾晠鍙湪澶ф枃浠跺嚭鐜帮級銆備慨澶嶏細璇锋眰 ID 鍏ㄥ眬鍞竴銆?     鈶?**鏆傚仠鍚庛€屽叏閮ㄧ户缁€嶅崱姝?*锛氭殏鍋滄湭涓柇 JSON 鎺ュ彛 鈫?鏈嶅姟绔凡瀹屾垚钀藉簱銆佸鎴风涓㈠純缁撴灉 鈫?        鍐嶆 complete 鎾?MinIO NoSuchUpload(500) 鈫?姘镐箙銆屼笂浼犱腑銆嶃€備慨澶嶄笁灞傦細
        鎺ュ彛 AbortSignal + 鏈嶅姟绔?complete 骞傜瓑鑷剤 + 瀹㈡埛绔?init 鏍￠獙鑷剤 + store 鍏堝垽鎴愬姛銆?     鈶?甯搁┗鏍忓搴﹁嚜閫傚簲锛?00px 绐楀彛鏂囦欢鍒楄〃 256px 鈫?356px锛?     娴嬭瘯濂椾欢锛堢湡瀹炴祻瑙堝櫒 Playwright + 鏈満 Edge锛岄渶 danger-full-access 鎵嶈兘 spawn 娴忚鍣級锛?     `_ui-hash-check.mjs`锛堝苟鍙戝搱甯?vs 涓茶鍩哄噯锛夈€乣_ui-upload-flow.mjs`锛? 鍦烘櫙锛屾姄鍏ㄩ儴 4xx/5xx锛夈€?     `_ui-dock-check.mjs`锛堝竷灞€鍑犱綍+鍛戒腑娴嬭瘯+4 绉嶇獥鍙ｅ搴︼級銆乣_cleanup-tests.mjs`锛堣蒋鍒犫啋purge 娓呯悊娴嬭瘯鏁版嵁锛?     杩愯鍓嶅厛 `docker compose up -d`锛岃剼鏈緷璧?`127.0.0.1:8080` 涓?`.env` 涓殑 admin 鍑嵁
   - **v1.1.9/v1.1.10/v1.1.11 浜や簰涓庢暟鎹潰淇**锛氬彇娑?Esc 鏀惰捣銆佹敹璧锋€佹敼甯︽枃瀛楃揣鍑戦潰鏉匡紱
     浠诲姟鍒楄〃榛樿**鎮诞娴眰**锛堟案涓嶆秷澶憋紝鏀寔涓婁紶+涓嬭浇浠诲姟銆佸埛鏂板悗浠嶅湪 localStorage 杩樺師锛夛紱
     涓婁紶鐩爣鐩綍琚垹鏃?*绔嬪嵆澶辫触涓嶉噸璇?*骞舵寜鐩綍鏁存壒娓呯悊锛堝疄娴嬫妸 291 娆?404 椋庢毚闄嶅埌 14锛?   - **v1.1.12 鍔熻兘浣撴濂椾欢**锛歚e2e/_ui-smoke.mjs` 绔埌绔窇鏍稿績鍔熻兘锛堢櫥褰?寤虹洰褰?涓婁紶/棰勮/
     閲嶅懡鍚?鎼滅储/鍒嗕韩/涓嬭浇鏂囦欢+鏂囦欢澶?鍒犻櫎鈫掑洖鏀剁珯鈫掓仮澶?鍚勯〉闈笌鎺ュ彛锛夛紝**33/33 閫氳繃**锛?     浣撴涓彂鐜板苟淇锛氫换鍔￠潰鏉?z-index(1200) 楂樹簬 antd 寮瑰眰(1050) 鈫?鐩栦綇琛屽唴銆屾洿澶氥€嶄笅鎷夎彍鍗曪紝
     瀵艰嚧閲嶅懡鍚?鍒嗕韩/涓嬭浇/鍒犻櫎绛夎鍐呮搷浣滃け鏁堬紙鐜板凡闄嶄负 900锛?     鍏ㄩ儴濂椾欢锛歚_ui-smoke` 33/33 路 `_upload-resilience` 30/30 路 `_ui-hash-check` 路
     `_ui-float-download` 路 `_ui-dir-gone` 路 `_ui-upload-flow` 路 `_ui-dock-check` 鍧囬€氳繃
     娉ㄦ剰锛氬悗鍙颁换鍔′笉缁ф壙鎻愭潈锛岃窇 Playwright 濂椾欢闇€鍓嶅彴 + danger-full-access

## 5. 瀹炴祴鍩虹嚎锛?026-08-24锛?
| 鎸囨爣 | 鏁板€?|
|---|---|
| 涓婁紶锛?12MB multipart 8 骞跺彂锛屽崟鐩橈級 | 33.6 MB/s |
| 600MB 棣栦紶 / 姹犳敞鍐?| 16.3s / 51.9s |
| 瀹瑰櫒鍐呬笅杞斤紙绌洪棽鍗曟祦 / 骞跺彂 / 浜夌敤鏈燂級 | 156 / 232-288 / 193 MB/s |
| 瀹夸富涓嬭浇锛圖ocker 绔彛杞彂闄愬埗锛?| 38.6-54.8 MB/s |
| computeObjectHash锛?00MB锛屽苟鍙?6 璺級 | 129 MB/s锛堝師 104锛?|
| 绉掍紶锛堝垹闄ゅ悗閲嶄紶 / 缂撳瓨鍛戒腑锛?| 46ms / 44ms |
| 520 鏂囦欢娴忚鍣ㄤ笂浼?| 鏂板鎭?520/520锛岄槦鍒?0 澶辫触锛垀700s锛?|
| BLAKE3 10GB 骞惰鍝堝笇 | 16.5s锛?20 MB/s锛?|
| Redis 鐩綍鍒楄〃缂撳瓨 | 瀹炴祴 3 杩炶 = 1 miss + 2 hit锛坘eyspace_hits 澧為噺楠岃瘉锛夛紝TTL 30s 鐢熸晥 |
| Redis 鍒嗕韩 meta 缂撳瓨 | 浜屾璁块棶鍛戒腑锛況evoke 鍚庣珛鍗冲け鏁堬紙smoke-redis-cache 15/15 鍏ㄧ豢锛?|
| 閰嶉閲嶇畻锛?0 涓囪 files锛宱wner 鑱氬悎 SUM锛?| 鍏ㄨ〃鎵?26.7ms / 3226 buffers 鈫?Index Only Scan 0.30ms / 9 buffers锛垀88x锛?|
| files 鐩綍鍒楄〃锛?0 琛?鐩綍锛?| idx_files_dir 0.356ms 鈫?uq_files_dir_name 0.185ms锛堝厤鍐椾綑绱㈠紩锛?|
| 鐩綍鍒楄〃锛? 涓囪鐩綍琛ㄣ€?500 瀛愮洰褰曪級 | idx_directories_parent + Sort 1.75ms锛圫ort 寮€閿€鍙拷鐣ワ紝鏈彟寤虹储寮曪級 |
| 璺緞鍓嶇紑鏌ヨ锛? 涓囪鐩綍锛?| idx_directories_path_pattern Bitmap 0.91ms锛汫IN trgm 2.15ms锛堝墠缂€ btree 鏇翠紭锛屾湭寤?GIN锛?|

## 6. 寰呭姙 / 涓嬩竴姝?
- [x] ~~鍏ㄩ噺 21k 鏂囦欢鐩綍涓婁紶鍥炲綊~~锛坴1.0.12 瀹炴祴瀹屾垚锛?1363 钀藉簱 / 0 澶辫触锛?- [x] ~~v1.1.x 绗笁杞細瀹屾暣鏂偣缁紶~~锛坴1.1.0 宸插疄鏂斤細IndexedDB + 鏈嶅姟绔垎鐗囨煡璇?+ 鑷姩鎭㈠锛?- [ ] 娴忚鍣ㄤ笅杞界粡 Docker 绔彛杞彂浠?38-55 MB/s鈥斺€斿闇€鏇撮珮鍙厤缃?host 缃戠粶/鍘熺敓缃戠粶妯″紡锛堥儴缃插眰锛?- [ ] 娴忚鍣ㄧ鏂囦欢澶规嫋鎷戒笂浼犳祴璇曪紙Playwright 瀵?webkitdirectory 鏀寔鏈夐檺锛屽彲鐢?DataTransfer 妯℃嫙锛?- [ ] 鍛藉悕鍗?vs N: bind 瀵规瘮澶嶆祴锛堟湰鏈鸿蛋 N: bind锛岀函鍛藉悕鍗锋洿蹇級
- [ ] 鍙€夛細Redis 鐗堟缂撳瓨锛堝綋鍓嶈繘绋嬪唴瀹炵幇锛?- [ ] 鍙€夛細涓嬭浇鏀圭粡鍚庣娴佸紡锛堥渶璇勪及 Docker 绔彛杞彂鏄惁浠嶆槸鐡堕锛?
## 7. 宸茬煡鍧戯紙寮€鍙戞椂娉ㄦ剰锛?
- **PowerShell 鍐呰仈 node**锛氬惈姝ｅ垯/寮曞彿杞箟鍑洪敊锛屼竴寰嬪啓鏂囦欢鑴氭湰鍐?`node xxx.mjs`銆?- **瀹瑰櫒鍐呮帰閽?*锛氬鍣ㄤ互 `node` 鐢ㄦ埛杩愯锛?app 鍙锛屾棩蹇楀啓 /tmp锛夛紱鎺㈤拡鎸?unref'd worker 鏃?  await 涓?settle 浼氫互閫€鍑虹爜 13 缁撴潫锛堜簨浠跺惊鐜┖杞級锛屽姞 `setInterval` 淇濇椿銆?- **鐧诲綍闄愭祦**锛? 娆?鍒嗛挓/IP+璐﹀彿锛屾祴璇曡剼鏈覆琛岃窇銆侀棿闅?60s+銆?- **棰勮浜や簰**锛氬崟鍑?*鏂囦欢鍚嶅崟鍏冩牸**瑙﹀彂棰勮锛堣鍙屽嚮浠呯洰褰曟湁鏁堬級锛沀I 涓嬭浇 = window.open 棰勭鍚?URL
  锛坅ttachment 鍝嶅簲娴忚鍣ㄧ洿鎺ヤ笅杞姐€佷笉瀵艰埅鏂伴〉绛撅級銆?- **nginx 鍔ㄦ€佽В鏋愶紙宸叉牴娌?502锛?*锛歚deploy/nginx/nginx.conf` 鐨?`/api/` location 鐢?  `resolver 127.0.0.11 valid=10s ipv6=off` + `set $backend http://server:3000` + `proxy_pass $backend`
  鍔ㄦ€佽В鏋?server 鍩熷悕锛圖ocker 鍐呯疆 DNS锛夈€傚疄娴嬪己鍒?server IP 鍙樻洿鍚?**涓嶉噸鍚?web锛屸墹10s 鑷姩鎭㈠**銆?  娉ㄦ剰锛氭敼 nginx.conf 闇€閲嶅缓 web 闀滃儚锛堥厤缃瀯寤烘湡鎷峰叆锛夛紱淇厤缃嬁鍥為€€涓洪潤鎬?`proxy_pass http://server:3000`銆?- **Redis 缂撳瓨閿惈 userId**锛欰CL 鏉冮檺鎽樿鏄寜鐢ㄦ埛瑙ｆ瀽鐨勶紝鍕垮幓鎺?userId 鍏变韩缂撳瓨銆?- **ioredis v6**锛氱敤 `import { Redis } from 'ioredis'`锛堥粯璁ゅ鍑哄湪 NodeNext 涓嬬被鍨嬪紓甯革級銆?- **N: 鐩樻槸鎱㈤€熸暟鎹洏**锛堢洿璇?620MB/s锛夛紝bind mount 杩涗竴姝ラ檷閫熲€斺€旀€ц兘缁撹浠ョ 5 鑺備负鍑嗐€?- **.wslconfig**锛歚memory=6GB processors=4 swap=2GB localhostForwarding=true`锛堝浠?`.wslconfig.bak`锛夈€?
## 8. 鍏虫満/鎭㈠鍛戒护閫熸煡

```powershell
# 浼橀泤鍋滄湇锛堝叧鏈哄墠锛?cd N:\濂囨€濆鎯砛minio-netdisk
docker compose stop        # 淇濈暀瀹瑰櫒涓庢暟鎹嵎锛屽紑鏈哄悗 up 鍗虫仮澶?# 寮€鏈烘仮澶?docker compose up -d
```
