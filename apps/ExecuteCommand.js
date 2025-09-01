import plugin from '../../../lib/plugins/plugin.js'
import RconManager from '../components/Rcon.js'
import Config from '../components/Config.js'

const LOG_PREFIX = logger.blue('[指令执行] ')

export class ExecuteCommand extends plugin {
  constructor() {
    super({
      /** 功能名称 */
      name: 'MCQQ-指令执行',
      event: 'message',
      /** 优先级，数字越小等级越高 */
      priority: 1009,
      rule: [
        {
          /** 命令正则匹配 */
          reg: '^#?执行指令\\s*(.*)$',
          /** 执行方法 */
          fnc: 'executeCommand',
        },
        {
          /** 帮助命令 */
          reg: '^#?指令帮助$',
          /** 执行方法 */
          fnc: 'showHelp',
        }
      ]
    })

    // 仅管理员可用的指令（机器人主人专用）
    this.adminOnlyCommands = [
      'stop', 'restart', 'shutdown', 'reload',
      'ban', 'ban-ip', 'pardon', 'pardon-ip', 
      'whitelist add', 'whitelist remove',
      'op', 'deop', 'kick', 'save-all',
      'difficulty', 'gamerule', 'worldborder'
    ]

    // 完全禁止的系统指令（安全考虑）
    this.forbiddenCommands = [
      'rm ', 'del ', 'delete ', 'format',
      'kill ', 'killall', 'sudo', 'chmod',
      'mv ', 'cp ', 'wget', 'curl'
    ]

    // 常用指令白名单（所有授权用户可用）
    this.safeCommands = [
      'list', 'help', 'tps', 'time', 'weather', 'seed', 
      'tp', 'teleport', 'give', 'summon', 'setblock',
      'fill', 'clone', 'gamemode', 'effect', 'enchant'
    ]
  }

  async executeCommand(e) {
    try {
      const config = Config.getConfig()
      const { mc_qq_server_list: serverList, debug_mode: debugMode } = config

      if (!serverList || serverList.length === 0) {
        await e.reply('❌ 没有配置任何服务器')
        return true
      }

      // 解析命令参数
      const [, args] = e.msg.match(this.rule[0].reg)
      if (!args || !args.trim()) {
        await this.showUsage(e)
        return true
      }

      const parsedCommand = this._parseCommand(args.trim())
      if (!parsedCommand.success) {
        await e.reply(parsedCommand.error)
        return true
      }

      const { serverName, command } = parsedCommand

      // 查找当前群关联的服务器
      const targetServers = serverList.filter(serverCfg =>
        serverCfg.group_list?.some(groupId => groupId == e.group_id)
      )

      if (targetServers.length === 0) {
        await e.reply('❌ 当前群未关联任何服务器')
        return true
      }

      // 权限检查
      const hasPermission = await this._checkPermission(e, targetServers, command)
      if (!hasPermission.success) {
        await e.reply(hasPermission.error)
        return true
      }

      // 安全检查
      const isSafe = this._checkCommandSafety(command)
      if (!isSafe.success) {
        await e.reply(isSafe.error)
        return true
      }

      // 确定目标服务器
      let serversToExecute = []
      if (serverName) {
        const targetServer = targetServers.find(server => server.server_name === serverName)
        if (!targetServer) {
          const availableServers = targetServers.map(s => s.server_name).join('、')
          await e.reply(`❌ 服务器"${serverName}"不存在或未关联到当前群\n可用服务器：${availableServers}`)
          return true
        }
        serversToExecute = [targetServer]
      } else {
        serversToExecute = targetServers
      }

      if (debugMode) {
        logger.info(LOG_PREFIX + `用户 ${e.user_id} 准备执行指令: ${command}`)
      }

      // 执行指令
      await this._executeOnServers(e, serversToExecute, command, debugMode)

    } catch (error) {
      logger.error(LOG_PREFIX + '执行指令时发生错误:', error)
      await e.reply('❌ 执行指令失败，请检查配置或稍后重试')
    }

    return true
  }

  async showHelp(e) {
    const isAdmin = e.isMaster
    
    const helpMessage = `🎮 指令执行帮助

📝 指令格式：
• #执行 <指令内容>
  - 在所有关联服务器执行指令

• #执行 <服务器名> <指令内容>
  - 在指定服务器执行指令

🔍 使用示例：
• #执行 list
• #执行 time set day
• #执行 生存服务器 weather clear
• #执行 创造服务器 gamemode creative @a

🛡️ 权限说明：
• 🟢 安全指令：授权用户可用
  ${this.safeCommands.slice(0, 8).join(', ')}...

• 🟡 管理员指令：仅机器人主人可用
  ${this.adminOnlyCommands.slice(0, 6).join(', ')}...

• 🔴 系统指令：完全禁用
  出于安全考虑被禁用

${isAdmin ? '🔑 您是机器人主人，可以使用所有非禁止指令' : '👤 您是授权用户，可以使用安全指令和一般指令'}

⚠️ 注意事项：
• 服务器需要RCON连接正常
• 指令长度限制500字符以内

💡 发送 #mc状态 可查看服务器连接状态`

    await e.reply(helpMessage)
    return true
  }

  async showUsage(e) {
    const usageMessage = `❓ 指令格式错误

正确格式：
• #执行 <指令内容>
• #执行 <服务器名> <指令内容>

示例：
• #执行 list
• #执行 生存服务器 time set day

发送 #指令帮助 查看详细说明`

    await e.reply(usageMessage)
  }

  /**
   * 解析指令参数
   * @param {string} args - 原始参数字符串
   * @returns {Object} 解析结果
   */
  _parseCommand(args) {
    const parts = args.split(' ')
    
    if (parts.length === 0) {
      return { success: false, error: '❌ 请提供要执行的指令' }
    }

    // 检查第一个参数是否为服务器名（包含中文或特殊字符的通常是服务器名）
    const firstPart = parts[0]
    const config = Config.getConfig()
    const serverList = config.mc_qq_server_list || []
    
    const isServerName = serverList.some(server => server.server_name === firstPart)
    
    if (isServerName && parts.length > 1) {
      // 指定服务器的格式
      return {
        success: true,
        serverName: firstPart,
        command: parts.slice(1).join(' ')
      }
    } else {
      // 通用格式（所有服务器）
      return {
        success: true,
        serverName: null,
        command: args
      }
    }
  }

  /**
   * 检查用户权限
   * @param {Object} e - 消息事件
   * @param {Array} targetServers - 目标服务器列表
   * @param {string} command - 要执行的指令
   * @returns {Object} 权限检查结果
   */
  async _checkPermission(e, targetServers, command) {
    const lowerCommand = command.toLowerCase()

    // 检查是否为仅管理员指令
    const isAdminOnlyCommand = this.adminOnlyCommands.some(admin => 
      lowerCommand.startsWith(admin.toLowerCase())
    )

    if (isAdminOnlyCommand) {
      // 仅管理员指令只有机器人主人可以执行
      if (!e.isMaster) {
        return { 
          success: false, 
          error: `🔒 管理员专用指令\n指令 "${command}" 仅限机器人主人使用\n这是为了服务器安全考虑` 
        }
      }
      return { success: true }
    }

    // 主人权限（可以执行所有非禁止指令）
    if (e.isMaster) {
      return { success: true }
    }

    // 检查是否为安全指令（授权用户可用）
    const isSafeCommand = this.safeCommands.some(safe => 
      lowerCommand.startsWith(safe.toLowerCase())
    )

    if (isSafeCommand) {
      // 安全指令检查服务器权限配置
      const hasServerPermission = targetServers.some(server => 
        server.command_user?.some(userId => userId == e.user_id)
      )
      
      if (hasServerPermission) {
        return { success: true }
      }
    }

    // 其他指令需要服务器配置的权限用户
    const hasServerPermission = targetServers.some(server => 
      server.command_user?.some(userId => userId == e.user_id)
    )

    if (!hasServerPermission) {
      return { 
        success: false, 
        error: `❌ 权限不足\n您需要是机器人主人或在服务器配置的授权用户列表中\n当前指令 "${command}" 需要管理员权限` 
      }
    }

    return { success: true }
  }

  /**
   * 检查指令安全性
   * @param {string} command - 要执行的指令
   * @returns {Object} 安全检查结果
   */
  _checkCommandSafety(command) {
    const lowerCommand = command.toLowerCase()
    
    // 检查完全禁止的系统指令
    for (const forbidden of this.forbiddenCommands) {
      if (lowerCommand.includes(forbidden.toLowerCase())) {
        return { 
          success: false, 
          error: `🚫 系统指令已被禁用\n检测到危险关键词: "${forbidden.trim()}"\n此类系统级指令出于安全考虑被完全禁用` 
        }
      }
    }

    // 检查指令长度（防止过长指令）
    if (command.length > 500) {
      return { 
        success: false, 
        error: '❌ 指令过长，请确保指令长度在500字符以内' 
      }
    }

    return { success: true }
  }

  /**
   * 在服务器上执行指令
   * @param {Object} e - 消息事件
   * @param {Array} servers - 服务器列表
   * @param {string} command - 指令
   * @param {boolean} debugMode - 调试模式
   */
  async _executeOnServers(e, servers, command, debugMode) {
    let resultMessage = `🎮 指令执行结果：\n指令：${command}\n`

    for (const serverCfg of servers) {
      const serverName = serverCfg.server_name
      const rconConnection = RconManager.activeConnections?.[serverName]

      if (!rconConnection) {
        resultMessage += `\n❌ ${serverName}：RCON未连接`
        continue
      }

      try {
        if (debugMode) {
          logger.mark(LOG_PREFIX + `向 ${serverName} 发送指令: ${command}`)
        }

        const response = await rconConnection.send(command)
        
        if (response !== null) {
          // 处理屏蔽词
          let processedResponse = response
          if (serverCfg.mask_word) {
            try {
              processedResponse = response.replace(new RegExp(serverCfg.mask_word, "g"), '')
            } catch (err) {
              if (debugMode) logger.error(LOG_PREFIX + `屏蔽词正则错误: ${err.message}`)
            }
          }

          // 格式化响应
          const formattedResponse = this._formatResponse(processedResponse)
          resultMessage += `\n✅ ${serverName}：\n${formattedResponse}`

          if (debugMode) {
            logger.mark(LOG_PREFIX + `${serverName} 返回: ${processedResponse}`)
          }
        } else {
          resultMessage += `\n⚠️ ${serverName}：指令已发送，但无响应`
        }
      } catch (error) {
        if (debugMode) {
          logger.error(LOG_PREFIX + `${serverName} 执行失败: ${error.message}`)
        }
        resultMessage += `\n❌ ${serverName}：执行失败 (${error.message})`
      }
    }

    await e.reply(resultMessage)
  }

  /**
   * 格式化服务器响应
   * @param {string} response - 原始响应
   * @returns {string} 格式化后的响应
   */
  _formatResponse(response) {
    if (!response || !response.trim()) {
      return '   (无返回内容)'
    }

    // 限制响应长度，防止消息过长
    const maxLength = 500
    let formatted = response.trim()
    
    if (formatted.length > maxLength) {
      formatted = formatted.substring(0, maxLength) + '...(内容已截断)'
    }

    // 添加缩进使格式更清晰
    return '   ' + formatted.replace(/\n/g, '\n   ')
  }
}
