const http = require('http');
const https = require('https'); // 👇 新增：引入 https 模块
const path = require('path');
const fs = require('fs');
const execSync = require('child_process').execSync;

// === 1. 动态读取本地 JSON 配置文件 ===
let config = {};
try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configData);
} catch (err) {
    console.error('❌ 无法读取配置文件 config.json，请确保文件存在且格式正确。错误原因:', err.message);
    process.exit(1);
}

// 映射配置变量（适配反代域名的参数结构）
const SERVER_HOST = config.SERVER_HOST || 'localhost';
const SERVER_PORT = config.SERVER_PORT || 3000;
const SERVER_PATH = config.SERVER_PATH || '/api/report'; // 支持配置 /vps/api/report
const USE_HTTPS = config.USE_HTTPS || false;            // 开启 HTTPS 协议开关
const SECRET_KEY = config.SECRET_KEY;
const VPS_ID = config.VPS_ID || 'Unknown-VPS';
const REPORT_INTERVAL = config.REPORT_INTERVAL || 5000;
const MONITOR_DIR_PATH = config.MONITOR_DIR_PATH || '';
const MONITOR_DIR_MAX_SIZE = config.MONITOR_DIR_MAX_SIZE || '';

// 选择网络请求模块
const httpClient = USE_HTTPS ? https : http;

// === 2. 辅助核心函数 ===

// 将大小配置字符串转为 KB
function parseSizeToKB(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.toUpperCase().match(/^(\d+(?:\.\d+)?)\s*([GM])$/);
    if (!match) return 0;
    const num = parseFloat(match);
    const unit = match[2];
    if (unit === 'G') return num * 1024 * 1024;
    if (unit === 'M') return num * 1024;
    return 0;
}

// 获取指定特定目录的占用百分比
function getCustomDirUsage() {
    if (!MONITOR_DIR_PATH || !MONITOR_DIR_MAX_SIZE) return null;
    try {
        const output = execSync(`du -sb "${MONITOR_DIR_PATH}" 2>/dev/null | awk '{print $1}'`).toString().trim();
        const currentBytes = parseInt(output) || 0;
        const currentKB = currentBytes / 1024;
        
        const maxKB = parseSizeToKB(MONITOR_DIR_MAX_SIZE);
        if (maxKB === 0) return null;

        const percentage = Math.round((currentKB / maxKB) * 100);
        return {
            path: MONITOR_DIR_PATH,
            max: MONITOR_DIR_MAX_SIZE,
            pct: percentage > 100 ? 100 : percentage
        };
    } catch (e) {
        return { path: MONITOR_DIR_PATH, max: MONITOR_DIR_MAX_SIZE, error: true };
    }
}

// 计算真实的 Linux CPU 使用率
let lastCpuTick = { idle: 0, total: 0 };
function getCpuUsage() {
    try {
        const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n');
        const parts = lines[0].split(/\s+/).slice(1).map(Number);
        const idle = parts[3]; 
        const total = parts.reduce((a, b) => a + b, 0);

        const deltaIdle = idle - lastCpuTick.idle;
        const deltaTotal = total - lastCpuTick.total;

        lastCpuTick = { idle, total };

        if (deltaTotal === 0) return 0;
        return Math.round((1 - deltaIdle / deltaTotal) * 100);
    } catch (e) { 
        return 0; 
    }
}

// 计算内存使用率
function getMemUsage() {
    try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const total = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)[1]);
        const available = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)[1]);
        return Math.round(((total - available) / total) * 100);
    } catch (e) { 
        return 0; 
    }
}

// 获取系统磁盘整体使用率
function getDiskUsage() {
    try {
        const output = execSync("df / | tail -1 | awk '{print $5}'").toString().trim();
        return parseInt(output.replace('%', '')) || 0;
    } catch (e) { 
        return 0; 
    }
}

// 获取系统在线运行时间
function getUptime() {
    try {
        const uptimeSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
        const d = Math.floor(uptimeSec / (3600 * 24));
        const h = Math.floor((uptimeSec % (3600 * 24)) / 3600);
        const m = Math.floor((uptimeSec % 3600) / 60);
        return `${d}天 ${h}时 ${m}分`;
    } catch (e) { 
        return '未知'; 
    }
}

// === 3. 数据定时上报核心逻辑 ===
function doReport() {
    const payload = JSON.stringify({
        secret: SECRET_KEY,
        id: VPS_ID,
        cpu: getCpuUsage(),
        mem: getMemUsage(),
        disk: getDiskUsage(),
        uptime: getUptime(),
        customDir: getCustomDirUsage()
    });

    // 动态适配反代环境的 options
    const options = {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path: SERVER_PATH, // 此时将请求发送至 /vps/api/report
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    // 使用动态选择的 httpClient (http 或 https) 发送
    const req = httpClient.request(options, (res) => {
        res.on('data', () => {}); 
    });
    
    req.on('error', (err) => {
        console.error(`[${VPS_ID}] 上报失败，无法连接到 ${SERVER_HOST}: ${err.message}`);
    });
    
    req.write(payload);
    req.end();
}

// 初始化 CPU 采样基准线
getCpuUsage(); 

// 启动循环轮询任务
console.log(`[${VPS_ID}] 成功加载反代配置。Agent已启动，正在上报至 ${USE_HTTPS ? 'https' : 'http'}://${SERVER_HOST}:${SERVER_PORT}${SERVER_PATH} ...`);
setInterval(doReport, REPORT_INTERVAL);
