import { Rcon } from 'rcon-client';
import Config from './Config.js';

const RCON_LOG_PREFIX = logger.blue('[Minecraft RCON] ');

// 连接状态常量
const CONNECTION_STATES = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting', 
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    FAILED: 'failed'
};

class RconManager {

    constructor() {
        this.activeConnections = {};
        this.connectionStates = {}; // 连接状态跟踪
        this.reconnectTimers = {}; // 重连定时器跟踪
        this.reconnectAttempts = {}; // 重连尝试次数跟踪
        this.heartbeatTimers = {}; // 心跳定时器
        this._initializeConnectionsAsync();
        this._startHeartbeatMonitor();
    }

    async _initializeConnectionsAsync() {
        try {
            const config = Config.getConfig();
            if (!config) {
                logger.error(RCON_LOG_PREFIX + '无法获取配置，RCON服务无法启动连接');
                return;
            }

            const { mc_qq_server_list: rconServerList } = config;
            if (!rconServerList || !Array.isArray(rconServerList)) {
                logger.info(RCON_LOG_PREFIX + '未配置RCON服务器列表或格式不正确');
                return;
            }

            rconServerList.forEach(serverCfg => {
                if (serverCfg.rcon_able && serverCfg.rcon_host && serverCfg.rcon_port && serverCfg.rcon_password && serverCfg.server_name) {
                    if (this.activeConnections[serverCfg.server_name]) {
                        logger.info(RCON_LOG_PREFIX + `已存在到 ${serverCfg.server_name} 的RCON连接，跳过`);
                    } else {
                        this._establishConnection(serverCfg);
                    }
                } else if (serverCfg.rcon_able) {
                    logger.warn(RCON_LOG_PREFIX + `RCON服务器配置 ${serverCfg.server_name || '未命名'} 不完整，跳过`);
                }
            });

        } catch (error) {
            logger.error(RCON_LOG_PREFIX + `初始化RCON连接失败: ${error.message}`);
        }
    }

    /**
     * 设置连接状态
     */
    _setConnectionState(serverName, state) {
        this.connectionStates[serverName] = state;
    }

    /**
     * 获取连接状态
     */
    _getConnectionState(serverName) {
        return this.connectionStates[serverName] || CONNECTION_STATES.DISCONNECTED;
    }

    /**
     * 清理连接相关资源
     */
    _cleanupConnection(serverName) {
        if (this.activeConnections[serverName]) {
            delete this.activeConnections[serverName];
        }
        if (this.reconnectTimers[serverName]) {
            clearTimeout(this.reconnectTimers[serverName]);
            delete this.reconnectTimers[serverName];
        }
    }

    /**
     * 计算重连延迟（指数退避）
     */
    _calculateReconnectDelay(attempts) {
        const baseDelay = 5000; // 基础延迟5秒
        const maxDelay = 300000; // 最大延迟5分钟
        const delay = Math.min(baseDelay * Math.pow(2, Math.min(attempts, 6)), maxDelay);
        return delay;
    }

    /**
     * 安排重连
     */
    _scheduleReconnect(serverCfg) {
        const serverName = serverCfg.server_name;
        
        // 防止重复重连
        if (this.reconnectTimers[serverName] || 
            this._getConnectionState(serverName) === CONNECTION_STATES.CONNECTING ||
            this._getConnectionState(serverName) === CONNECTION_STATES.RECONNECTING) {
            return;
        }

        if (!serverCfg.rcon_able) {
            logger.info(RCON_LOG_PREFIX + `${serverName} RCON已禁用，停止重连`);
            return;
        }

        const attempts = (this.reconnectAttempts[serverName] || 0) + 1;
        this.reconnectAttempts[serverName] = attempts;
        
        const delay = this._calculateReconnectDelay(attempts);
        const maxAttempts = serverCfg.rcon_max_attempts || 3;
        
        // 短期重连（有限次数）和长期重连（无限次数，更长间隔）
        if (attempts <= maxAttempts) {
            logger.info(RCON_LOG_PREFIX + `${serverName} 将在 ${delay/1000} 秒后尝试重新连接... (尝试次数: ${attempts}/${maxAttempts})`);
        } else {
            // 长期重连，每5分钟尝试一次
            const longTermDelay = 300000; // 5分钟
            logger.info(RCON_LOG_PREFIX + `${serverName} 进入长期重连模式，将在 ${longTermDelay/1000} 秒后重试...`);
            
            this.reconnectTimers[serverName] = setTimeout(() => {
                this._attemptReconnect(serverCfg);
            }, longTermDelay);
            return;
        }

        this._setConnectionState(serverName, CONNECTION_STATES.RECONNECTING);
        this.reconnectTimers[serverName] = setTimeout(() => {
            this._attemptReconnect(serverCfg);
        }, delay);
    }

    /**
     * 尝试重连
     */
    async _attemptReconnect(serverCfg) {
        const serverName = serverCfg.server_name;
        delete this.reconnectTimers[serverName];
        
        if (!serverCfg.rcon_able) {
            logger.info(RCON_LOG_PREFIX + `${serverName} RCON已禁用，取消重连`);
            this._setConnectionState(serverName, CONNECTION_STATES.DISCONNECTED);
            return;
        }

        await this._establishConnection(serverCfg);
    }

    async _establishConnection(serverCfg, isReconnect = false) {
        const { server_name: serverName, rcon_host: host, rcon_port: port, rcon_password: password } = serverCfg;

        // 防止重复连接
        const currentState = this._getConnectionState(serverName);
        if (currentState === CONNECTION_STATES.CONNECTING || currentState === CONNECTION_STATES.CONNECTED) {
            return;
        }

        this._setConnectionState(serverName, CONNECTION_STATES.CONNECTING);
        
        if (!isReconnect) {
            this.reconnectAttempts[serverName] = 0;
        }

        logger.info(RCON_LOG_PREFIX + `尝试连接到 ${serverName} (${host}:${port})...`);

        const rcon = new Rcon({
            host: host,
            port: port,
            password: password,
            timeout: 15000 // 增加超时时间
        });

        try {
            await rcon.connect();
            logger.mark(RCON_LOG_PREFIX + logger.green(serverName) + ' RCON连接成功');
            
            // 连接成功，重置重连计数
            this.activeConnections[serverName] = rcon;
            this.reconnectAttempts[serverName] = 0;
            this._setConnectionState(serverName, CONNECTION_STATES.CONNECTED);

            // 设置事件监听器
            rcon.on('end', () => {
                logger.mark(RCON_LOG_PREFIX + logger.yellow(serverName) + ' RCON连接已断开');
                this._cleanupConnection(serverName);
                this._setConnectionState(serverName, CONNECTION_STATES.DISCONNECTED);
                this._scheduleReconnect(serverCfg);
            });

            rcon.on('error', (err) => {
                logger.error(RCON_LOG_PREFIX + logger.red(serverName) + ` RCON连接发生错误: ${err.message}`);
                this._cleanupConnection(serverName);
                this._setConnectionState(serverName, CONNECTION_STATES.DISCONNECTED);
                this._scheduleReconnect(serverCfg);
            });

        } catch (error) {
            logger.warn(RCON_LOG_PREFIX + logger.red(serverName) + ` RCON连接失败: ${error.message}`);
            this._cleanupConnection(serverName);
            this._setConnectionState(serverName, CONNECTION_STATES.FAILED);
            this._scheduleReconnect(serverCfg);
        }
    }

    /**
     * 手动重连指定服务器
     */
    async forceReconnect(serverName) {
        const config = Config.getConfig();
        const serverCfg = config.mc_qq_server_list?.find(s => s.server_name === serverName);
        
        if (!serverCfg) {
            logger.error(RCON_LOG_PREFIX + `未找到服务器配置: ${serverName}`);
            return false;
        }

        if (!serverCfg.rcon_able) {
            logger.info(RCON_LOG_PREFIX + `${serverName} RCON已禁用`);
            return false;
        }

        logger.info(RCON_LOG_PREFIX + `手动重连 ${serverName}...`);
        
        // 清理现有连接和定时器
        this._cleanupConnection(serverName);
        this.reconnectAttempts[serverName] = 0;
        
        await this._establishConnection(serverCfg, false);
        return true;
    }

    /**
     * 获取连接状态信息
     */
    getConnectionStatus() {
        const status = {};
        const config = Config.getConfig();
        const serverList = config.mc_qq_server_list || [];
        
        serverList.forEach(serverCfg => {
            if (serverCfg.rcon_able) {
                const serverName = serverCfg.server_name;
                status[serverName] = {
                    state: this._getConnectionState(serverName),
                    connected: !!this.activeConnections[serverName],
                    reconnectAttempts: this.reconnectAttempts[serverName] || 0,
                    hasReconnectTimer: !!this.reconnectTimers[serverName]
                };
            }
        });
        
        return status;
    }

    /**
     * 启动心跳监控
     */
    _startHeartbeatMonitor() {
        // 每30秒检查一次所有连接
        setInterval(() => {
            this._performHeartbeatCheck();
        }, 30000);
    }

    /**
     * 执行心跳检查
     */
    async _performHeartbeatCheck() {
        const config = Config.getConfig();
        if (!config?.mc_qq_server_list) return;

        for (const [serverName, rcon] of Object.entries(this.activeConnections)) {
            try {
                // 发送简单的list命令作为心跳
                const startTime = Date.now();
                await Promise.race([
                    rcon.send('list'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Heartbeat timeout')), 10000))
                ]);
                
                const responseTime = Date.now() - startTime;
                if (responseTime > 8000) {
                    logger.warn(RCON_LOG_PREFIX + `${serverName} 心跳响应缓慢 (${responseTime}ms)`);
                }
            } catch (error) {
                logger.warn(RCON_LOG_PREFIX + `${serverName} 心跳检查失败: ${error.message}`);
                
                // 心跳失败，可能连接已死，强制重连
                if (this.activeConnections[serverName]) {
                    const serverCfg = config.mc_qq_server_list.find(s => s.server_name === serverName);
                    if (serverCfg) {
                        this._cleanupConnection(serverName);
                        this._setConnectionState(serverName, CONNECTION_STATES.DISCONNECTED);
                        this._scheduleReconnect(serverCfg);
                    }
                }
            }
        }
    }
}

export default new RconManager();