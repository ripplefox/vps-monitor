const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// === 1. 读取本地 JSON 配置文件 ===
let config = {};
try {
    const configPath = path.join(__dirname, 'server_config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
    console.error('❌ 无法读取配置文件 server_config.json:', err.message);
    process.exit(1);
}

const PORT = config.PORT || 3000;
const SECRET_KEY = config.SECRET_KEY;
const ALERT_ENABLED = config.ALERT_ENABLED || false;

// 存储服务器数据与告警历史变量
let vpsData = {};
let alertHistory = {};        // 格式: { "HK-01": 1711234567890 } -> 记录上一次真实告警的时间戳
let disconnectStartTime = {}; // 格式: { "HK-01": 1711234567890 } -> 记录首次断线的起始时间

// === 2.1 ntfy 鉴权头构造 (优先 access token, 回退用户名密码) ===
function buildNtfyAuthHeader() {
    // 推荐用 access token: 不需要在多处保存密码, 且可随时吊销
    if (config.NTFY_TOKEN) {
        return { 'Authorization': `Bearer ${config.NTFY_TOKEN}` };
    }
    // 回退方案: Basic 认证 (用户名 + 密码)
    if (config.NTFY_USER && config.NTFY_PASSWORD) {
        const basic = Buffer.from(`${config.NTFY_USER}:${config.NTFY_PASSWORD}`).toString('base64');
        return { 'Authorization': `Basic ${basic}` };
    }
    console.warn('[ntfy 告警] 未配置 NTFY_TOKEN 或 NTFY_USER/NTFY_PASSWORD, 将以匿名身份发送 (服务器大概率拒绝)');
    return {};
}

// === 2. ntfy 消息发送函数 (纯原生网络请求) ===
// title: 消息标题 (X-Title); bodyText: 消息正文; logTag: 控制台日志前缀
function sendNtfyMessage(title, bodyText, logTag) {
    if (!config.NTFY_SERVER || !config.NTFY_TOPIC) return;

    try {
        const targetUrl = new URL(`${config.NTFY_SERVER}/${config.NTFY_TOPIC}`);
        const httpModule = targetUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                // 使用 URL 百分比编码传输中文标题，配合 utf-8 声明，在手机 ntfy 客户端中完美显示中文
                // Node 的请求头只接受 latin1, 这里把 UTF-8 文本转成原始字节直发;
                // ntfy 默认按 UTF-8 解析标题, 不要用 encodeURIComponent (那样 ntfy 不会解码)
                'X-Title': Buffer.from(title, 'utf8').toString('latin1'),
                'X-Priority': '5', // 5 = Max 紧急程度，手机端会弹出强警报并置顶
                'X-Tags': 'warning,computer',
                // 鉴权: access token 优先, 其次用户名密码
                ...buildNtfyAuthHeader()
            }
        };

        const req = httpModule.request(options, (res) => {
            let respBody = '';
            res.on('data', (chunk) => { respBody += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`[${logTag}] 发送成功: ${title} (HTTP ${res.statusCode})`);
                } else {
                    console.error(`[${logTag}] 发送失败: ${title} HTTP ${res.statusCode} ${respBody.slice(0, 200)}`);
                }
            });
        });

        req.on('error', (e) => console.error('ntfy 发送错误:', e.message));
        req.write(bodyText);
        req.end();
    } catch (e) {
        console.error('解析 ntfy URL 失败:', e.message);
    }
}

// === 2.2 VPS 离线告警 ===
function sendNtfyAlert(vpsId, reason) {
    if (!ALERT_ENABLED) return;

    console.log(`[ntfy 告警触发] 正在为 [${vpsId}] 发送通知...`);

    sendNtfyMessage(
        vpsId,
        `节点名称: ${vpsId}\n触发原因: ${reason}\n\n※ 24小时内同节点仅通知一次。`,
        'ntfy 告警'
    );
}

// === 2.3 服务启动通知 (可用 NTFY_STARTUP_NOTICE=false 关闭) ===
function sendStartupNotice() {
    if (config.NTFY_STARTUP_NOTICE === false) return;
    sendNtfyMessage('监控启动', '[看板主控端] 服务已完美启动！', 'ntfy 启动通知');
}

// === 3. 定时轮询：每 10 秒扫描一次所有 VPS 的在线状态 ===
setInterval(() => {
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;           // 5 分钟缓冲防抖 (300,000 毫秒)
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000; // 24 小时防轰炸

    Object.keys(vpsData).forEach(id => {
        const node = vpsData[id];
        const isOnline = (now - node.lastSeen) < 120000; // 120秒没心跳判定网页端离线

        if (!isOnline) {
            // 1. 如果是第一次检测到失联，仅记录当前时间，激活防抖观察
            if (!disconnectStartTime[id]) {
                disconnectStartTime[id] = now;
                console.log(`[防抖激活] 检测到 [${id}] 失去心跳，开始 5 分钟倒计时观察...`);
                return;
            }

            // 2. 计算当前已经连续断线了多少毫秒
            const disconnectedDuration = now - disconnectStartTime[id];

            // 如果连续断线还没有满 5 分钟，控制台打印日志并继续观察，拦截警报打扰
            if (disconnectedDuration < FIVE_MINUTES) {
                const remainingSec = Math.round((FIVE_MINUTES - disconnectedDuration) / 1000);
                console.log(`[防抖观察] [${id}] 已断线 ${Math.round(disconnectedDuration/1000)} 秒，若持续满 5 分钟将在 ${remainingSec} 秒后报警`);
                return;
            }

            // 3. 已经连续断线超过 5 分钟了，检查 24 小时防轰炸冷却限制
            const lastAlertTime = alertHistory[id] || 0;
            if (now - lastAlertTime < TWENTY_FOUR_HOURS) {
                return; 
            }

            // 4. 确认真实断线满 5 分钟且处于冷却外，执行报警推送
            alertHistory[id] = now;
            sendNtfyAlert(id, `服务器已持续断开连接超过 5 分钟（确认为真实宕机或网络死锁，非瞬时抖动）。`);

        } else {
            // 5. 核心防抖解除：只要机器在 5 分钟内恢复了心跳，立刻抹去断线记录，成功拦截网络波动误报
            if (disconnectStartTime[id]) {
                console.log(`[防抖解除] 🎉 [${id}] 在 5 分钟内恢复了心跳，成功拦截网络抖动误报。`);
                delete disconnectStartTime[id];
            }
        }
    });
}, 10000);

// === 4. HTTP 服务器与前端网页逻辑 ===
const htmlPage = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>VPS 看板</title>
    <style>
        body { font-family: -apple-system, sans-serif; background: #f4f6f9; margin: 20px; }
        h1 { color: #333; text-align: center; }
        .container { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; max-width: 1200px; margin: 0 auto; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); position: relative; }
        .badge { position: absolute; top: 20px; right: 20px; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
        .online { background: #e6fffa; color: #234e52; } .offline { background: #fff5f5; color: #9b2c2c; }
        .vps-id { font-size: 20px; font-weight: bold; margin-bottom: 15px; color: #2d3748; }
        .stat-item { margin: 8px 0; font-size: 14px; color: #4a5568; }
        .progress-bar { background: #edf2f7; border-radius: 4px; height: 8px; overflow: hidden; margin-top: 4px; }
        .progress { background: #48bb78; height: 100%; transition: width 0.5s; }
        .high { background: #f56565; } .custom-dir { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #e2e8f0; }
    </style>
</head>
<body>
    <h1>🛸 服务器集中看板</h1>
    <div class="container" id="board">正在同步服务器状态...</div>
    <script>
        async function refresh() {
            try {
                const res = await fetch('api/status'); // 使用相对路径，完美自适应反向代理路径环境
                const data = await res.json();
                document.getElementById('board').innerHTML = data.length === 0 ? '<p style="text-align:center;width:100%">暂无机器上报数据</p>' : data.map(vps => {
                    let customDirHtml = '';
                    if (vps.customDir) {
                        customDirHtml = vps.customDir.error 
                            ? \`<div class="stat-item custom-dir" style="color:#e53e3e;font-size:12px;">⚠️ 目录未找到或无权限: \${vps.customDir.path}</div>\`
                            : \`<div class="stat-item custom-dir">📁 目录占满度 (\${vps.customDir.path}): \${vps.customDir.pct}% / \${vps.customDir.max}<div class="progress-bar"><div class="progress \${vps.customDir.pct >= 90 ? 'high' : ''}" style="width:\${vps.customDir.pct}%"></div></div></div>\`;
                    }
                    return \`<div class="card">
                        <span class="badge \${vps.online ? 'online' : 'offline'}">\${vps.online ? '在线' : '离线'}</span>
                        <div class="vps-id">\${vps.id}</div>
                        <div class="stat-item">CPU: \${vps.cpu}%<div class="progress-bar"><div class="progress \${vps.cpu>80?'high':''}" style="width:\${vps.cpu}%"></div></div></div>
                        <div class="stat-item">内存: \${vps.mem}%<div class="progress-bar"><div class="progress \${vps.mem>80?'high':''}" style="width:\${vps.mem}%"></div></div></div>
                        <div class="stat-item">系统磁盘: \${vps.disk}%<div class="progress-bar"><div class="progress \${vps.disk>90?'high':''}" style="width:\${vps.disk}%"></div></div></div>
                        \${customDirHtml}
                        <div style="margin-top:15px;font-size:12px;color:#a0aec0;">
                            运行: \${(() => {
                                if (!vps.uptime) return '未知';
                                // 如果是老版本 Windows Agent 通过特殊编码处理过的冒号数据，在浏览器端安全渲染
                                if (vps.uptime.includes(':')) {
                                    const parts = vps.uptime.split(':');
                                    return \`\${parts[0]}天 \${parts[1]}时 \${parts[2]}分\`;
                                }
                                return vps.uptime;
                            })()}
                        </div>
                    </div>\`;
                }).join('');
            } catch (e) { console.error(e); }
        }
        refresh(); setInterval(refresh, 3000);
    </script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
    // 抹除反代路径带来的前缀差异，获取纯净路由路径
    const urlPath = req.url.split('?')[0];

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(htmlPage);
    }
    
    // 前端数据拉取接口（支持反代后的相对/绝对调用）
    if (req.method === 'GET' && (urlPath === '/api/status' || urlPath.endsWith('/api/status'))) {
        const now = Date.now();
        const result = Object.keys(vpsData).map(id => {
            const node = vpsData[id];
            return { id, ...node, online: (now - node.lastSeen) < 120000 };
        });
        
        // 核心排序：强制按 VPS 别名进行固定字母及数字 A-Z 升序排列
        result.sort((a, b) => a.id.localeCompare(b.id, 'zh-CN', { numeric: true }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
    }
    
    // 接收客户端 Agent 数据上报接口
    if (req.method === 'POST' && (urlPath === '/api/report' || urlPath.endsWith('/api/report'))) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.secret !== SECRET_KEY) { 
                    res.writeHead(403); 
                    return res.end('Unauthorized'); 
                }
                // 更新内存中的 VPS 数据快照
                vpsData[data.id] = { 
                    cpu: data.cpu, mem: data.mem, disk: data.disk, 
                    uptime: data.uptime, customDir: data.customDir, 
                    lastSeen: Date.now() 
                };
                res.writeHead(200); 
                res.end('OK');
            } catch (err) { 
                res.writeHead(400); 
                res.end('Bad Request'); 
            }
        });
        return;
    }
    res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => { 
    console.log(`[看板主控端] 服务已完美启动！`);
    console.log(`监听本地端口: ${PORT} | ntfy 告警引擎: ${ALERT_ENABLED ? '开启' : '关闭'}`);
    // 启动即发一条通知, 确认服务已就绪
    sendStartupNotice();
});
