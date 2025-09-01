import plugin from "../../../lib/plugins/plugin.js";
import RconManager from "../components/Rcon.js";
import WebSocketManager from "../components/WebSocket.js";
import Config from "../components/Config.js";

const LOG_PREFIX = logger.blue('[服务器关机] ');

export class Shutdown extends plugin {
  constructor() {
    super({
      name: "MCQQ-服务器关机",
      event: "message",
      priority: 1008,
      rule: [
        {
          reg: "^#?mc关机(?:\\s+(\\d+))?$",
          fnc: "shutdown",
          permission: "master"
        },
        {
          reg: "^#?mc重启(?:\\s+(\\d+))?$",
          fnc: "restart", 
          permission: "master"
        },
        {
          reg: "^#?mc取消关机$",
          fnc: "cancelShutdown",
          permission: "master"
        },
        {
          reg: "^#?mc关机帮助$",
          fnc: "showHelp"
        }
      ],
    });

    // 存储各服务器的关机任务
    this.shutdownTasks = {};
  }

  async shutdown(e) {
    if (!e.isGroup) {
      return false;
    }

    const [, countdownTime] = e.msg.match(this.rule[0].reg);
    const countdown = countdownTime ? parseInt(countdownTime) : 10; // 默认10秒倒计时

    if (countdown < 5 || countdown > 300) {
      await e.reply('❌ 倒计时时间必须在5-300秒之间');
      return true;
    }

    await this._initiateShutdown(e, countdown, 'stop');
    return true;
  }

  async restart(e) {
    if (!e.isGroup) {
      return false;
    }

    const [, countdownTime] = e.msg.match(this.rule[1].reg);
    const countdown = countdownTime ? parseInt(countdownTime) : 10; // 默认10秒倒计时

    if (countdown < 5 || countdown > 300) {
      await e.reply('❌ 倒计时时间必须在5-300秒之间');
      return true;
    }

    await this._initiateShutdown(e, countdown, 'restart');
    return true;
  }

  async cancelShutdown(e) {
    if (!e.isGroup) {
      return false;
    }

    const config = Config.getConfig();
    const { mc_qq_server_list: serverList, debug_mode: debugMode } = config;

    if (!serverList || serverList.length === 0) {
      await e.reply('❌ 没有配置任何服务器');
      return true;
    }

    const targetServers = serverList.filter(serverCfg =>
      serverCfg.group_list?.some(groupId => groupId == e.group_id)
    );

    if (targetServers.length === 0) {
      await e.reply('❌ 当前群未关联任何服务器');
      return true;
    }

    let cancelledCount = 0;
    let totalCount = 0;

    for (const serverCfg of targetServers) {
      const serverName = serverCfg.server_name;
      totalCount++;

      if (this.shutdownTasks[serverName]) {
        // 取消关机任务
        this._cancelServerShutdown(serverName);
        cancelledCount++;

        // 发送取消通知
        await this._sendTitleToServer(serverCfg, '🟢 关机已取消', '操作人员已取消服务器关机', debugMode);
        
        if (debugMode) {
          logger.info(LOG_PREFIX + `${serverName} 关机任务已取消`);
        }
      }
    }

    if (cancelledCount > 0) {
      await e.reply(`✅ 已取消 ${cancelledCount}/${totalCount} 个服务器的关机任务`);
    } else {
      await e.reply('ℹ️ 当前没有进行中的关机任务');
    }

    return true;
  }

  async showHelp(e) {
    const helpMessage = `🔧 服务器关机功能帮助

📝 可用指令：
• #mc关机 [秒数]  - 关闭服务器（默认10秒倒计时）
• #mc重启 [秒数]  - 重启服务器（默认10秒倒计时）
• #mc取消关机     - 取消进行中的关机任务
• #mc关机帮助     - 显示此帮助信息

⏰ 倒计时说明：
• 倒计时范围：5-300秒
• 倒计时过程中会显示标题提醒
• 可在倒计时期间取消关机

🔍 使用示例：
• #mc关机          (10秒后关机)
• #mc关机 30       (30秒后关机)
• #mc重启 60       (60秒后重启)
• #mc取消关机      (取消所有关机任务)

⚠️ 注意事项：
• 仅限机器人主人使用
• 执行前请确保已保存重要数据
• 关机将影响所有在线玩家

🔒 安全提示：此功能具有极高权限，请谨慎使用！`;

    await e.reply(helpMessage);
    return true;
  }

  /**
   * 启动关机流程
   */
  async _initiateShutdown(e, countdown, action) {
    const config = Config.getConfig();
    const { mc_qq_server_list: serverList, debug_mode: debugMode } = config;

    if (!serverList || serverList.length === 0) {
      await e.reply('❌ 没有配置任何服务器');
      return;
    }

    const targetServers = serverList.filter(serverCfg =>
      serverCfg.group_list?.some(groupId => groupId == e.group_id)
    );

    if (targetServers.length === 0) {
      await e.reply('❌ 当前群未关联任何服务器');
      return;
    }

    // 检查是否有服务器正在关机
    const busyServers = targetServers.filter(s => this.shutdownTasks[s.server_name]);
    if (busyServers.length > 0) {
      const busyNames = busyServers.map(s => s.server_name).join('、');
      await e.reply(`⚠️ 以下服务器正在执行关机任务：${busyNames}\n请先取消现有任务或等待完成`);
      return;
    }

    const actionText = action === 'restart' ? '重启' : '关机';
    await e.reply(`🔴 服务器${actionText}指令已确认！\n倒计时 ${countdown} 秒开始...\n使用 #mc取消关机 可以中止操作`);

    // 为每个服务器启动关机流程
    for (const serverCfg of targetServers) {
      this._startServerShutdown(serverCfg, countdown, action, debugMode);
    }

    logger.warn(LOG_PREFIX + `用户 ${e.user_id} 启动了服务器${actionText}流程，倒计时 ${countdown} 秒`);
  }

  /**
   * 启动单个服务器的关机流程
   */
  _startServerShutdown(serverCfg, countdown, action, debugMode) {
    const serverName = serverCfg.server_name;
    
    // 清理可能存在的旧任务
    this._cancelServerShutdown(serverName);

    const task = {
      serverCfg: serverCfg,
      action: action,
      countdown: countdown,
      currentCount: countdown,
      debugMode: debugMode,
      startTime: Date.now(),
      interval: null,
      finalTimeout: null
    };

    this.shutdownTasks[serverName] = task;

    // 发送初始通知
    const actionText = action === 'restart' ? '重启' : '关机';
    this._sendTitleToServer(serverCfg, `服务器即将${actionText}`, `倒计时 ${countdown} 秒`, debugMode);

    // 启动精确倒计时
    this._scheduleNextUpdate(serverName);

    if (debugMode) {
      logger.info(LOG_PREFIX + `${serverName} ${actionText}倒计时已启动 (${countdown}秒)`);
    }
  }

  /**
   * 安排下一次更新
   */
  _scheduleNextUpdate(serverName) {
    const task = this.shutdownTasks[serverName];
    if (!task) return;

    // 计算下一秒的精确时间点
    const elapsed = Date.now() - task.startTime;
    const targetTime = Math.ceil(elapsed / 1000) * 1000; // 下一个整秒
    const delay = targetTime - elapsed;

    task.interval = setTimeout(() => {
      this._updateCountdown(serverName);
    }, Math.max(delay, 0));
  }

  /**
   * 更新倒计时
   */
  async _updateCountdown(serverName) {
    const task = this.shutdownTasks[serverName];
    if (!task) return;

    // 基于实际经过时间计算当前倒计时
    const elapsed = Date.now() - task.startTime;
    const elapsedSeconds = Math.floor(elapsed / 1000);
    task.currentCount = Math.max(0, task.countdown - elapsedSeconds);

    const actionText = task.action === 'restart' ? '重启' : '关机';

    if (task.currentCount > 0) {
      // 继续倒计时
      let titleText = '';
      let subtitleText = '';

      if (task.currentCount <= 5) {
        // 最后5秒，显示大号数字
        titleText = `${task.currentCount}`;
        subtitleText = `服务器即将${actionText}`;
      } else if (task.currentCount <= 10) {
        // 最后10秒提醒
        titleText = `${actionText}倒计时`;
        subtitleText = `还有 ${task.currentCount} 秒`;
      } else if (task.currentCount % 10 === 0 || task.currentCount <= 30) {
        // 每10秒或最后30秒提醒
        titleText = `服务器即将${actionText}`;
        subtitleText = `倒计时 ${task.currentCount} 秒`;
      }

      if (titleText) {
        // 异步发送标题，不阻塞倒计时
        this._sendTitleToServer(task.serverCfg, titleText, subtitleText, task.debugMode).catch(error => {
          if (task.debugMode) {
            logger.error(LOG_PREFIX + `${serverName} 发送标题失败: ${error.message}`);
          }
        });
      }

      // 安排下一次更新
      this._scheduleNextUpdate(serverName);

    } else {
      // 倒计时结束，执行关机
      await this._executeShutdown(serverName);
    }
  }

  /**
   * 执行关机
   */
  async _executeShutdown(serverName) {
    const task = this.shutdownTasks[serverName];
    if (!task) return;

    const actionText = task.action === 'restart' ? '重启' : '关机';
    const command = task.action === 'restart' ? 'restart' : 'stop';

    try {
      // 发送最终通知
      await this._sendTitleToServer(task.serverCfg, `服务器${actionText}中...`, '请稍后重新连接', task.debugMode);

      // 等待1秒让标题显示
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 执行关机命令
      const rconConnection = RconManager.activeConnections?.[serverName];
      if (rconConnection) {
        await rconConnection.send(command);
        logger.warn(LOG_PREFIX + `${serverName} ${actionText}命令已执行`);
      } else {
        logger.error(LOG_PREFIX + `${serverName} RCON连接不可用，无法执行${actionText}命令`);
      }

    } catch (error) {
      logger.error(LOG_PREFIX + `${serverName} 执行${actionText}命令失败: ${error.message}`);
    } finally {
      // 清理任务
      this._cancelServerShutdown(serverName);
    }
  }

  /**
   * 取消服务器关机任务
   */
  _cancelServerShutdown(serverName) {
    const task = this.shutdownTasks[serverName];
    if (task) {
      if (task.interval) {
        clearTimeout(task.interval);
      }
      if (task.finalTimeout) {
        clearTimeout(task.finalTimeout);
      }
      delete this.shutdownTasks[serverName];
    }
  }

  /**
   * 发送标题到服务器
   */
  async _sendTitleToServer(serverCfg, title, subtitle = '', debugMode = false) {
    const serverName = serverCfg.server_name;
    const rconConnection = RconManager.activeConnections?.[serverName];
    const wsConnection = WebSocketManager.activeSockets?.[serverName];

    if (!rconConnection && !wsConnection) {
      if (debugMode) {
        logger.warn(LOG_PREFIX + `${serverName} 无可用连接，无法发送标题`);
      }
      return;
    }

    try {
      if (wsConnection) {
        // 优先使用WebSocket
        const wsPayload = JSON.stringify({
          api: "send_title",
          data: { 
            title: title,
            subtitle: subtitle
          },
          echo: String(Date.now())
        });
        
        wsConnection.send(wsPayload);
        
        if (debugMode) {
          logger.info(LOG_PREFIX + `${serverName} 通过WebSocket发送标题: ${title}`);
        }
      } else if (rconConnection) {
        // 使用RCON发送标题
        let command = `title @a title {"text":"${title}"}`;
        await rconConnection.send(command);
        
        if (subtitle) {
          command = `title @a subtitle {"text":"${subtitle}"}`;
          await rconConnection.send(command);
        }
        
        if (debugMode) {
          logger.info(LOG_PREFIX + `${serverName} 通过RCON发送标题: ${title}`);
        }
      }
    } catch (error) {
      if (debugMode) {
        logger.error(LOG_PREFIX + `${serverName} 发送标题失败: ${error.message}`);
      }
    }
  }

  /**
   * 获取关机任务状态
   */
  getShutdownStatus() {
    const status = {};
    for (const [serverName, task] of Object.entries(this.shutdownTasks)) {
      // 基于实际时间计算剩余时间
      const elapsed = Date.now() - task.startTime;
      const elapsedSeconds = Math.floor(elapsed / 1000);
      const remaining = Math.max(0, task.countdown - elapsedSeconds);
      
      status[serverName] = {
        action: task.action,
        countdown: task.countdown,
        currentCount: remaining,
        remaining: remaining,
        elapsed: elapsedSeconds
      };
    }
    return status;
  }
}
