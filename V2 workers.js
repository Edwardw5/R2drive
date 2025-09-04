// A single-file, full-featured, authenticated Cloud Drive on Cloudflare Workers and R2
// Version 4.1: Re-introduced file icons, multi-select, batch operations, visual folder selector.

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const method = request.method;
        const isLoggedIn = await checkAuth(request, env);

        if (url.pathname.startsWith("/api/")) {
            if (!isLoggedIn) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { 'Content-Type': 'application/json' } });
            
            if (request.method === 'GET' && url.pathname === '/api/list-all-folders') {
                return handleListAllFolders(env);
            }

            if (request.method === 'POST') {
                const action = url.pathname.replace("/api/", "");
                const data = await request.json();

                switch (action) {
                    case "create-folder":
                        return handleCreateFolder(env, data.path);
                    case "rename":
                        return handleRename(env, data.oldKey, data.newKey);
                    case "delete": {
                        const deletedSize = await getObjectsSize(env, data.keys);
                        const result = await handleDelete(env, data.keys);
                        if(result.ok) {
                           ctx.waitUntil(updateTotalSize(env, -deletedSize));
                        }
                        return result;
                    }
                    case "move":
                    case "copy": {
                        const isMove = action === 'move';
                        const copiedSize = await getObjectsSize(env, data.keys);
                        const result = await handleMoveOrCopy(env, data.keys, data.destination, isMove);
                        if(result.ok && !isMove) {
                            ctx.waitUntil(updateTotalSize(env, copiedSize));
                        }
                        return result;
                    }
                    default:
                        return new Response(JSON.stringify({ error: "Invalid API action" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
            }
        }

        switch (method) {
            case "GET":
                if (url.pathname === "/login") return handleLoginPage(env);
                if (url.pathname === "/logout") return handleLogout();
                if (url.pathname.startsWith("/download/")) return handleFile(env, url.pathname.replace("/download/", ""), "attachment");
                if (url.pathname.startsWith("/preview/")) return handleFile(env, url.pathname.replace("/preview/", ""), "inline");
                return handleListPage(request, env, isLoggedIn, ctx);
            case "POST":
                if (url.pathname === "/login") return handleLoginPost(request, env);
                if (url.pathname === "/upload") {
                    if (!isLoggedIn) return new Response("Forbidden", { status: 403 });
                    return handleUpload(request, env, ctx);
                }
            default:
                return new Response("Not Found", { status: 404 });
        }
    },
};

async function updateTotalSize(env, sizeChange) {
    if(!env.STATS_KV) return;
    let currentSize = parseFloat(await env.STATS_KV.get("totalSize") || "0");
    currentSize += sizeChange;
    if (currentSize < 0) currentSize = 0;
    await env.STATS_KV.put("totalSize", currentSize.toString());
}

async function recalculateTotalSize(env) {
    if(!env.STATS_KV) return;
    let totalSize = 0;
    let cursor;
    do {
        const list = await env.MY_BUCKET.list({ cursor });
        totalSize = list.objects.reduce((sum, obj) => sum + obj.size, totalSize);
        cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    await env.STATS_KV.put("totalSize", totalSize.toString());
    await env.STATS_KV.put("lastRecalculated", new Date().toISOString());
}

async function getObjectsSize(env, keys) {
    let totalSize = 0;
    for (const key of keys) {
        if (key.endsWith('/')) {
            let cursor;
            do {
                const list = await env.MY_BUCKET.list({ prefix: key, cursor });
                totalSize = list.objects.reduce((sum, obj) => sum + obj.size, totalSize);
                cursor = list.truncated ? list.cursor : undefined;
            } while (cursor);
        } else {
            const obj = await env.MY_BUCKET.head(key);
            if (obj) totalSize += obj.size;
        }
    }
    return totalSize;
}

async function handleListPage(request, env, isLoggedIn, ctx) {
    const url = new URL(request.url);
    const prefix = decodeURIComponent(url.pathname.substring(1));
    let totalSize = 0;
    if (env.STATS_KV) {
        let cachedSize = await env.STATS_KV.get("totalSize");
        if (cachedSize === null) {
            ctx.waitUntil(recalculateTotalSize(env));
            cachedSize = "0";
        }
        totalSize = parseFloat(cachedSize);
        const lastRecalculated = await env.STATS_KV.get("lastRecalculated");
        if (!lastRecalculated || (new Date() - new Date(lastRecalculated)) > 86400000) {
            ctx.waitUntil(recalculateTotalSize(env));
        }
    }
    const list = await env.MY_BUCKET.list({ prefix, delimiter: '/' });
    const folders = list.delimitedPrefixes.map(p => ({ key: p, name: p.replace(prefix, '').replace(/\/$/, '') }));
    const files = list.objects.filter(obj => !obj.key.endsWith('/') && obj.size > 0).map(obj => {
        const fileInfo = getFileInfo(obj.key);
        return {
            key: obj.key,
            name: obj.key.replace(prefix, ''),
            size: formatBytes(obj.size),
            uploaded: obj.uploaded.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            httpMetadata: obj.httpMetadata,
            icon: fileInfo.icon
        }
    });
    return new Response(generateHTML({ prefix, folders, files, isLoggedIn, env, totalSize }), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleUpload(request, env, ctx) {
    const formData = await request.formData();
    const file = formData.get("file");
    const path = formData.get("path") || "";
    if (!file || !file.name || file.size === 0) return new Response(JSON.stringify({error: "No file uploaded"}), { status: 400 });
    const key = path + file.name;
    await env.MY_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    ctx.waitUntil(updateTotalSize(env, file.size));
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' }});
}

async function handleCreateFolder(env, path) {
    if (!path.endsWith('/')) path += '/';
    await env.MY_BUCKET.put(path, null);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleRename(env, oldKey, newKey) {
    if (oldKey.endsWith('/')) {
        let cursor;
        do {
            const list = await env.MY_BUCKET.list({ prefix: oldKey, cursor });
            for (const obj of list.objects) {
                const newObjKey = obj.key.replace(oldKey, newKey);
                const object = await env.MY_BUCKET.get(obj.key);
                if (object) {
                    await env.MY_BUCKET.put(newObjKey, object.body, { httpMetadata: object.httpMetadata });
                    await env.MY_BUCKET.delete(obj.key);
                }
            }
            cursor = list.truncated ? list.cursor : undefined;
        } while(cursor)
    } else {
        const object = await env.MY_BUCKET.get(oldKey);
        if (object === null) return new Response(JSON.stringify({ error: "Object not found" }), { status: 404 });
        await env.MY_BUCKET.put(newKey, object.body, { httpMetadata: object.httpMetadata });
        await env.MY_BUCKET.delete(oldKey);
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleDelete(env, keys) {
    const keysToDelete = [];
    for (const key of keys) {
        if (key.endsWith('/')) {
            let cursor;
            do {
                const list = await env.MY_BUCKET.list({ prefix: key, cursor });
                list.objects.forEach(obj => keysToDelete.push(obj.key));
                cursor = list.truncated ? list.cursor : undefined;
            } while(cursor)
        } else {
            keysToDelete.push(key);
        }
    }
    if (keysToDelete.length > 0) {
       await env.MY_BUCKET.delete(keysToDelete);
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleMoveOrCopy(env, sourceKeys, destination, isMove) {
    for (const sourceKey of sourceKeys) {
        const name = sourceKey.replace(/\/$/, '').split('/').pop();
        const destKey = destination + name + (sourceKey.endsWith('/') ? '/' : '');
        if (sourceKey.endsWith('/')) {
            let cursor;
            do {
                const list = await env.MY_BUCKET.list({ prefix: sourceKey, cursor });
                for (const obj of list.objects) {
                    const newObjKey = destKey + obj.key.substring(sourceKey.length);
                    const object = await env.MY_BUCKET.get(obj.key);
                    if(object){
                        await env.MY_BUCKET.put(newObjKey, object.body, { httpMetadata: object.httpMetadata });
                        if (isMove) await env.MY_BUCKET.delete(obj.key);
                    }
                }
                cursor = list.truncated ? list.cursor : undefined;
            } while(cursor)
        } else {
            const object = await env.MY_BUCKET.get(sourceKey);
            if (object === null) continue;
            await env.MY_BUCKET.put(destKey, object.body, { httpMetadata: object.httpMetadata });
            if (isMove) await env.MY_BUCKET.delete(sourceKey);
        }
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleListAllFolders(env) {
    const folders = new Set();
    folders.add('/');
    let cursor;
    do {
        const list = await env.MY_BUCKET.list({ cursor });
        for (const obj of list.objects) {
            if(obj.key.endsWith('/')){
                folders.add('/' + obj.key);
            } else {
                const parts = obj.key.split('/');
                parts.pop();
                let currentPath = '';
                for (const part of parts) {
                    currentPath += part + '/';
                    folders.add('/' + currentPath);
                }
            }
        }
        cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    return new Response(JSON.stringify(Array.from(folders).map(f => f.slice(1))), { headers: { 'Content-Type': 'application/json' } });
}

function generateHTML({ prefix, folders, files, isLoggedIn, env, totalSize }) {
    const siteTitle = env.SITE_TITLE || 'Cloud Drive';
    const breadcrumbs = generateBreadcrumbs(prefix);
    const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024;
    const usedPercentage = Math.min((totalSize / R2_FREE_TIER_BYTES) * 100, 100).toFixed(2);
    const folderRows = folders.map(folder => `<tr class="item-row" data-key="${escapeHtml(folder.key)}" data-name="${escapeHtml(folder.name)}" data-type="folder"><td><input type="checkbox" class="item-checkbox"></td><td><a href="/${escapeHtml(folder.key)}" class="item-link"><span class="icon">📁</span>${escapeHtml(folder.name)}</a></td><td>--</td><td>--</td><td>文件夹</td></tr>`).join('');
    const fileRows = files.map(file => `<tr class="item-row" data-key="${escapeHtml(file.key)}" data-name="${escapeHtml(file.name)}" data-type="file" data-size="${escapeHtml(file.size)}" data-uploaded="${escapeHtml(file.uploaded)}"><td><input type="checkbox" class="item-checkbox"></td><td><a href="/preview/${escapeHtml(file.key)}" target="_blank" class="item-link"><span class="icon">${file.icon}</span>${escapeHtml(file.name)}</a></td><td>${file.size}</td><td>${file.uploaded}</td><td>文件</td></tr>`).join('');
    const adminControls = isLoggedIn ? `<div class="admin-controls"><button id="new-folder-btn">新建文件夹</button><label for="file-input" class="button-like-label">上传文件</label><input type="file" id="file-input" style="display:none;" multiple><a href="/logout" class="button">退出登录</a></div>` : '<a href="/login" class="button">管理员登录</a>';
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(siteTitle)}</title><style>:root{--primary-color:#007bff;--hover-color:#0056b3;--danger-color:#dc3545;--progress-bg:#e9ecef;--progress-bar:#007bff;--selection-bg: #cfe2ff;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;margin:0;background-color:#f8f9fa;color:#333;user-select:none;}a{color:var(--primary-color);text-decoration:none;}a:hover{text-decoration:underline;}.container{max-width:1200px;margin:2rem auto;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1);}.header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;border-bottom:2px solid #eef;padding-bottom:1rem;margin-bottom:1rem;gap:1rem;}.admin-controls{display:flex;gap:1rem;align-items:center;}.admin-controls button,.button,.button-like-label{background:var(--primary-color);color:#fff;border:none;padding:0.5rem 1rem;border-radius:5px;cursor:pointer;font-size:14px;text-decoration:none;display:inline-block;white-space:nowrap;}.admin-controls button:hover,.button:hover,.button-like-label:hover{background:var(--hover-color);}.breadcrumbs{margin-bottom:1rem;font-size:1.1rem;word-break:break-all;}.file-table{width:100%;border-collapse:collapse;}.file-table th,.file-table td{padding:10px 15px;text-align:left;border-bottom:1px solid #ddd;vertical-align:middle;}.file-table th{background-color:#f1f3f5;}.item-row.selected{background-color:var(--selection-bg);}.item-link{display:flex;align-items:center;gap:0.75em;}.icon{font-size:1.2em;}.stats-bar{margin-bottom:1rem;}.stats-bar .label{display:flex;justify-content:space-between;font-size:0.9em;color:#666;margin-bottom:0.25rem;}.progress-container{width:100%;background-color:var(--progress-bg);border-radius:5px;overflow:hidden;}.progress-bar{height:10px;}.upload-progress-container{margin-top:1rem;display:none;}.upload-progress-container .progress-bar{height:20px;text-align:center;color:white;line-height:20px;font-size:12px;}.context-menu{display:none;position:absolute;z-index:1000;background:#fff;border-radius:5px;box-shadow:0 2px 10px rgba(0,0,0,0.2);padding:5px 0;min-width:180px;}.context-menu div{padding:8px 15px;cursor:pointer;}.context-menu div:hover{background:#f1f3f5;}.context-menu hr{border:none;border-top:1px solid #eee;margin:4px 0;}.modal{display:none;position:fixed;z-index:2000;left:0;top:0;width:100%;height:100%;overflow:auto;background-color:rgba(0,0,0,0.4);}.modal-content{background-color:#fefefe;margin:10% auto;padding:20px;border:1px solid #888;width:80%;max-width:600px;border-radius:8px;}.modal-content h2{margin-top:0;}.modal-content input[type="text"]{width:calc(100% - 22px);padding:10px;margin-bottom:10px;border:1px solid #ccc;border-radius:4px;}.modal-content .buttons{text-align:right;margin-top:20px;}.modal-content button{padding:10px 15px;border-radius:5px;border:none;cursor:pointer;margin-left:10px;}.modal-content button.primary{background-color:var(--primary-color);color:white;}.modal-content button.cancel{background-color:#6c757d;color:white;}#folder-tree{max-height:300px;overflow-y:auto;border:1px solid #eee;padding:10px;}.folder-tree ul{list-style:none;padding-left:20px;}.folder-tree li{padding:4px;cursor:pointer;border-radius:4px;}.folder-tree li.selected{background-color:var(--selection-bg);font-weight:bold;}.folder-tree li:hover{background-color:#f1f3f5;}</style></head><body><div class="container"><div class="header"><h1>${escapeHtml(siteTitle)}</h1>${adminControls}</div><div class="stats-bar"><div class="label"><span>磁盘占用 (免费额度 10 GB)</span><span>${formatBytes(totalSize)} / 10 GB</span></div><div class="progress-container"><div class="progress-bar" style="width:${usedPercentage}%;background-color:var(--progress-bar)"></div></div></div><div class="upload-progress-container"></div><div class="breadcrumbs">${breadcrumbs}</div><table class="file-table"><thead><tr><th style="width:25px;"><input type="checkbox" id="select-all-checkbox"></th><th style="width:50%;">名称</th><th>大小</th><th>修改日期</th><th>类型</th></tr></thead><tbody>${folderRows}${fileRows}</tbody></table>${(folders.length===0&&files.length===0)?'<p style="text-align:center;padding:2rem;color:#888;">这个文件夹是空的。</p>':''}</div><div class="context-menu" id="context-menu"><div id="ctx-preview">👁️ 预览</div><div id="ctx-download">📥 下载</div><div id="ctx-share">🔗 分享</div><hr><div id="ctx-rename">✏️ 重命名</div><div id="ctx-move">➡️ 移动到</div><div id="ctx-copy">📋 复制到</div><hr><div id="ctx-details">ℹ️ 详细信息</div><div id="ctx-delete" style="color:var(--danger-color);">🗑️ 删除</div></div><div id="rename-modal" class="modal"><div class="modal-content"><h2>重命名</h2><input type="text" id="rename-input" placeholder="输入新名称"><div class="buttons"><button class="cancel" onclick="closeAllModals()">取消</button><button class="primary" id="rename-confirm">确认</button></div></div></div><div id="share-modal" class="modal"><div class="modal-content"><h2>分享链接</h2><input type="text" id="share-link-input" readonly><div class="buttons"><button class="cancel" onclick="closeAllModals()">关闭</button><button class="primary" id="copy-link-btn">复制</button></div></div></div><div id="details-modal" class="modal"><div class="modal-content"><h2>详细信息</h2><div id="details-content"></div><div class="buttons"><button class="primary" onclick="closeAllModals()">关闭</button></div></div></div><div id="folder-selector-modal" class="modal"><div class="modal-content"><h2 id="folder-selector-title"></h2><div id="folder-tree"></div><div class="buttons"><button class="cancel" onclick="closeAllModals()">取消</button><button class="primary" id="folder-selector-confirm">确认</button></div></div></div>
    <script>
    document.addEventListener('DOMContentLoaded',()=>{const selectedKeys=new Set();const fileTable=document.querySelector('.file-table');const rows=[...fileTable.querySelectorAll('.item-row')];let lastSelectedRow=null;const updateSelectionState=()=>{rows.forEach(row=>{const checkbox=row.querySelector('.item-checkbox');const key=row.dataset.key;if(selectedKeys.has(key)){row.classList.add('selected');checkbox.checked=true}else{row.classList.remove('selected');checkbox.checked=false}});document.getElementById('select-all-checkbox').checked=rows.length>0&&rows.length===selectedKeys.size};fileTable.addEventListener('click',e=>{const row=e.target.closest('.item-row');if(!row)return;if(e.target.tagName==='A'||e.target.parentElement.tagName==='A'||e.target.tagName==='INPUT')return;const checkbox=row.querySelector('.item-checkbox');const key=row.dataset.key;if(e.shiftKey&&lastSelectedRow){const lastIndex=rows.indexOf(lastSelectedRow);const currentIndex=rows.indexOf(row);const[start,end]=lastIndex<currentIndex?[lastIndex,currentIndex]:[currentIndex,lastIndex];const shouldSelect=!selectedKeys.has(key);for(let i=start;i<=end;i++){const keyToToggle=rows[i].dataset.key;if(shouldSelect)selectedKeys.add(keyToToggle);else selectedKeys.delete(keyToToggle)}}else if(e.ctrlKey||e.metaKey){if(selectedKeys.has(key))selectedKeys.delete(key);else selectedKeys.add(key)}else{const isSelected=selectedKeys.has(key);selectedKeys.clear();if(!isSelected)selectedKeys.add(key)}lastSelectedRow=row;updateSelectionState()});document.getElementById('select-all-checkbox').addEventListener('change',e=>{const isChecked=e.target.checked;rows.forEach(row=>{if(isChecked)selectedKeys.add(row.dataset.key);else selectedKeys.delete(row.dataset.key)});updateSelectionState()});const contextMenu=document.getElementById('context-menu');let currentItem=null;fileTable.addEventListener('contextmenu',e=>{const row=e.target.closest('.item-row');if(!row||!${isLoggedIn})return;e.preventDefault();currentItem={key:row.dataset.key,name:row.dataset.name,type:row.dataset.type,size:row.dataset.size};if(!selectedKeys.has(currentItem.key)){selectedKeys.clear();selectedKeys.add(currentItem.key);updateSelectionState();lastSelectedRow=row}const fileOnlyItems=['ctx-preview','ctx-download','ctx-share'];fileOnlyItems.forEach(id=>document.getElementById(id).style.display=currentItem.type==='file'?'block':'none');const isSingleFolder=selectedKeys.size===1&&currentItem.type==='folder';document.getElementById('ctx-rename').style.display=selectedKeys.size===1?'block':'none';document.getElementById('ctx-details').style.display=selectedKeys.size===1?'block':'none';contextMenu.style.display='block';contextMenu.style.left=e.pageX+'px';contextMenu.style.top=e.pageY+'px'});document.addEventListener('click',e=>{if(!contextMenu.contains(e.target))contextMenu.style.display='none'});window.closeAllModals=()=>document.querySelectorAll('.modal').forEach(m=>m.style.display='none');async function apiCall(action,body){try{const res=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!res.ok){const err=await res.json().catch(()=>({error:'操作失败'}));throw new Error(err.error)}return await res.json()}catch(error){alert('错误: '+error.message);return null}}const newFolderBtn=document.getElementById('new-folder-btn');if(newFolderBtn)newFolderBtn.addEventListener('click',async()=>{const folderName=prompt('请输入新文件夹的名称:');if(folderName&&folderName.trim()){const result=await apiCall('create-folder',{path:'${escapeHtml(prefix)}'+folderName.trim()});if(result&&result.success)location.reload()}});const fileInput=document.getElementById('file-input');const uploadContainer=document.querySelector('.upload-progress-container');if(fileInput)fileInput.addEventListener('change',async()=>{const files=fileInput.files;if(files.length===0)return;uploadContainer.style.display='block';uploadContainer.innerHTML='';for(const file of files){const progressId='progress-'+Math.random().toString(36).substr(2,9);const progressHTML=\`<div class="label" id="label-\${progressId}">正在上传: \${file.name}</div><div class="progress-container"><div class="progress-bar" id="\${progressId}" style="width:0%;background-color:var(--progress-bar)">0%</div></div>\`;uploadContainer.insertAdjacentHTML('beforeend',progressHTML);const formData=new FormData();formData.append('path','${escapeHtml(prefix)}');formData.append('file',file);const xhr=new XMLHttpRequest();xhr.open('POST','/upload',true);xhr.upload.onprogress=e=>{if(e.lengthComputable){const percent=(e.loaded/e.total*100).toFixed(0);const bar=document.getElementById(progressId);bar.style.width=percent+'%';bar.innerText=percent+'%'}};xhr.onload=()=>{const label=document.getElementById('label-'+progressId);if(xhr.status===200)label.innerText=\`上传成功: \${file.name}\`;else label.innerText=\`上传失败: \${file.name}\`};xhr.onerror=()=>document.getElementById('label-'+progressId).innerText=\`上传出错: \${file.name}\`;await new Promise(resolve=>{xhr.onloadend=resolve;xhr.send(formData)})};setTimeout(()=>location.reload(),1000)});const getTargets=()=>{return selectedKeys.size>0?Array.from(selectedKeys):[currentItem.key]};document.getElementById('ctx-preview').addEventListener('click',()=>{window.open(\`/preview/\${encodeURIComponent(currentItem.key)}\`,'_blank')});document.getElementById('ctx-download').addEventListener('click',()=>{getTargets().forEach(key=>{if(!key.endsWith('/'))window.open(\`/download/\${encodeURIComponent(key)}\`)})});document.getElementById('ctx-delete').addEventListener('click',async()=>{const targets=getTargets();const msg=\`确定要删除\${targets.length}个项目吗？此操作无法撤销。\`;if(confirm(msg)){const result=await apiCall('delete',{keys:targets});if(result&&result.success)location.reload()}});const folderSelectorModal=document.getElementById('folder-selector-modal');const folderTreeContainer=document.getElementById('folder-tree');let folderTree=[];let selectedFolder=null;const openFolderSelector=async(mode)=>{const targets=getTargets();const title=document.getElementById('folder-selector-title');title.textContent=\`\${mode==='move'?'移动':'复制'} \${targets.length} 个项目到\`;const res=await fetch('/api/list-all-folders');const folders=await res.json();folderTreeContainer.innerHTML='';const buildTree=pathList=>{const tree={};pathList.forEach(path=>{path.split('/').filter(Boolean).reduce((acc,name)=>{acc[name]=acc[name]||{};return acc[name]},tree)});return tree};const renderTree=(node,container,path)=>{const ul=document.createElement('ul');if(path!=='/')ul.style.paddingLeft='20px';else ul.style.paddingLeft='0px';Object.keys(node).sort().forEach(name=>{const li=document.createElement('li');const currentPath=path+name+'/';li.textContent=name;li.dataset.path=currentPath;li.onclick=e=>{e.stopPropagation();if(selectedFolder)selectedFolder.classList.remove('selected');li.classList.add('selected');selectedFolder=li};if(Object.keys(node[name]).length>0){renderTree(node[name],li,currentPath)}ul.appendChild(li)});container.appendChild(ul)};const rootNode=buildTree(folders);renderTree(rootNode,folderTreeContainer,'/');folderSelectorModal.style.display='block';document.getElementById('folder-selector-confirm').onclick=async()=>{if(selectedFolder){const destination=selectedFolder.dataset.path;const result=await apiCall(mode,{keys:targets,destination:destination});if(result&&result.success)location.reload()}else{alert('请选择一个目标文件夹。')}}};document.getElementById('ctx-move').addEventListener('click',()=>openFolderSelector('move'));document.getElementById('ctx-copy').addEventListener('click',()=>openFolderSelector('copy'));document.getElementById('ctx-rename').addEventListener('click',()=>{const modal=document.getElementById('rename-modal');const input=document.getElementById('rename-input');input.value=currentItem.name;modal.style.display='block';document.getElementById('rename-confirm').onclick=async()=>{const newName=input.value.trim();if(newName&&newName!==currentItem.name){const oldPath=currentItem.key.substring(0,currentItem.key.length-currentItem.name.length);const newKey=oldPath+newName+(currentItem.type==='folder'?'/':'');const result=await apiCall('rename',{oldKey:currentItem.key,newKey:newKey});if(result&&result.success)location.reload()}}});document.getElementById('ctx-share').addEventListener('click',()=>{const link=\`\${window.location.origin}/download/\${encodeURIComponent(currentItem.key)}\`;const modal=document.getElementById('share-modal');modal.querySelector('input').value=link;modal.style.display='block';modal.querySelector('#copy-link-btn').onclick=()=>{navigator.clipboard.writeText(link).then(()=>alert('链接已复制!'))}});document.getElementById('ctx-details').addEventListener('click',()=>{const modal=document.getElementById('details-modal');let details=\`名称: \${currentItem.name}\\n类型: \${currentItem.type==='folder'?'文件夹':'文件'}\`;if(currentItem.type==='file'){details+=\`\\n大小: \${currentItem.size}\\n上传于: \${currentItem.uploaded}\`}details+=\`\\n\\n完整路径: \${currentItem.key}\`;modal.querySelector('#details-content').innerText=details;modal.style.display='block'})})</script></body></html>`;
}

function getFileInfo(filename) {
    const extension = filename.split('.').pop().toLowerCase();
    const fileTypes = {
        'jpg': { icon: '🖼️' }, 'jpeg': { icon: '🖼️' },'png': { icon: '🖼️' }, 'gif': { icon: '🖼️' }, 'webp': { icon: '🖼️' }, 'svg': { icon: '🖼️' }, 'bmp': { icon: '🖼️' }, 'ico': { icon: '🖼️' },
        'mp4': { icon: '🎥' }, 'mov': { icon: '🎥' }, 'avi': { icon: '🎥' }, 'mkv': { icon: '🎥' }, 'webm': { icon: '🎥' }, 'wmv': { icon: '🎥' }, 'flv': { icon: '🎥' },
        'mp3': { icon: '🎵' }, 'wav': { icon: '🎵' }, 'flac': { icon: '🎵' }, 'aac': { icon: '🎵' }, 'ogg': { icon: '🎵' }, 'm4a': { icon: '🎵' },
        'pdf': { icon: '📄' }, 'doc': { icon: '📄' }, 'docx': { icon: '📄' }, 'xls': { icon: '📄' }, 'xlsx': { icon: '📄' }, 'ppt': { icon: '📄' }, 'pptx': { icon: '📄' }, 'txt': { icon: '📄' }, 'md': { icon: '📄' },
        'zip': { icon: '📦' }, 'rar': { icon: '📦' }, '7z': { icon: '📦' }, 'tar': { icon: '📦' }, 'gz': { icon: '📦' },
        'html': { icon: '💻' }, 'css': { icon: '💻' }, 'js': { icon: '💻' }, 'json': { icon: '💻' }, 'xml': { icon: '💻' }, 'py': { icon: '💻' }, 'java': { icon: '💻' }, 'c': { icon: '💻' }, 'cpp': { icon: '💻' }, 'cs': { icon: '💻' }, 'sh': { icon: '💻' },
        'exe': { icon: '⚙️' }, 'dmg': { icon: '⚙️' }, 'apk': { icon: '⚙️' },
    };
    return fileTypes[extension] || { icon: '❓' };
}
function formatBytes(bytes, decimals = 2) { if (!bytes || bytes === 0) return '0 Bytes'; const k = 1024; const dm = decimals < 0 ? 0 : decimals; const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(bytes) / Math.log(k)); return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]; }
function escapeHtml(unsafe) { if (typeof unsafe !== 'string') return ''; return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function generateBreadcrumbs(prefix) { if (!prefix) return '<a href="/">根目录</a>'; const parts = prefix.replace(/\/$/, '').split('/'); let path = ''; const links = parts.map((part, index) => { path += part + '/'; const name = decodeURIComponent(part); if (index === parts.length - 1) return `<span> / ${escapeHtml(name)}</span>`; return `<span> / </span><a href="/${escapeHtml(path)}">${escapeHtml(name)}</a>`; }); return `<a href="/">根目录</a>${links.join('')}`; }
const AUTH_COOKIE_NAME = "__my_drive_auth";
async function checkAuth(request, env) { const cookie = request.headers.get("Cookie"); if (!cookie) return false; const match = cookie.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`)); if (!match) return false; const [value, iv, salt] = match[1].split('.'); if (!value || !iv || !salt) return false; try { const secretKey = await createKey(env.COOKIE_SECRET, salt); const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(iv) }, secretKey, hexToBytes(value)); const decodedValue = new TextDecoder().decode(decrypted); return decodedValue === env.ADMIN_USERNAME; } catch (e) { return false; } }
async function handleLoginPost(request, env) { const formData = await request.formData(); const username = formData.get("username"); const password = formData.get("password"); if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) { const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16))); const iv = crypto.getRandomValues(new Uint8Array(12)); const secretKey = await createKey(env.COOKIE_SECRET, salt); const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, secretKey, new TextEncoder().encode(username)); const cookieValue = `${bytesToHex(new Uint8Array(encrypted))}.${bytesToHex(iv)}.${salt}`; const headers = new Headers({ "Location": "/" }); headers.set("Set-Cookie", `${AUTH_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`); return new Response(null, { status: 302, headers }); } else { const headers = new Headers({ "Location": "/login?error=1" }); return new Response("Invalid credentials", { status: 302, headers }); } }
function handleLogout() { const headers = new Headers({ "Location": "/" }); headers.set("Set-Cookie", `${AUTH_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`); return new Response(null, { status: 302, headers }); }
async function handleFile(env, key, disposition) { key = decodeURIComponent(key); if (!key) return new Response("File not specified.", { status: 400 }); const object = await env.MY_BUCKET.get(key); if (object === null) return new Response("Object Not Found", { status: 404 }); const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); headers.set("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(key.split('/').pop())}`); return new Response(object.body, { headers }); }
function handleLoginPage(env) { return new Response(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录 - ${env.SITE_TITLE || 'Cloud Drive'}</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background-color:#f4f7f9}form{background:white;padding:2rem;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1);width:320px}h1{text-align:center;color:#1a2a4c}label{display:block;margin-bottom:.5rem}input{width:100%;padding:.75rem;margin-bottom:1rem;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}button{width:100%;padding:.75rem;background-color:#007bff;color:white;border:none;border-radius:4px;font-size:1rem;cursor:pointer}button:hover{background-color:#0056b3}</style></head><body><form action="/login" method="post"><h1>管理员登录</h1><label for="username">用户名:</label><input type="text" id="username" name="username" required><label for="password">密码:</label><input type="password" id="password" name="password" required><button type="submit">登录</button></form></body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8" } }); }
async function createKey(secret, salt) { const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "PBKDF2" }, false, ["deriveKey"]); return await crypto.subtle.deriveKey({ name: "PBKDF2", salt: hexToBytes(salt), iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); }
function hexToBytes(hex) { const bytes = new Uint8Array(hex.length / 2); for (let i = 0; i < bytes.length; i++) { bytes[i] = parseInt(hex.substr(i * 2, 2), 16); } return bytes; }
function bytesToHex(bytes) { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }