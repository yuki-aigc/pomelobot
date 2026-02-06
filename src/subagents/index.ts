import type { SubAgent } from 'deepagents';
import type { Config } from '../config.js';

/**
 * Create the skill-writing subagent
 */
export function createSkillWriterSubagent(_config: Config): SubAgent {
    return {
        name: 'skill-writer-agent',
        description: '技能编写专家子代理。专门创建和管理技能文件(SKILL.md)。当用户需要创建新技能或修改现有技能时，使用此子代理。',
        systemPrompt: `你是一个技能编写专家。你的职责是创建和管理 SKILL.md 技能文件。

技能文件格式规范：
\`\`\`markdown
---
name: 技能名称
description: 技能描述（简短）
---

# 技能名称

## Overview
技能的概述和用途说明

## Instructions
### 步骤1
详细的使用步骤

### 步骤2
更多步骤...

## Examples
使用示例
\`\`\`

创建技能时：
1. 在 workspace/skills/ 目录下创建新文件夹
2. 在文件夹中创建 SKILL.md 文件
3. 按照上述格式编写技能内容
4. 技能名称应该用英文小写加连字符（如 weather-query）

请使用文件系统工具来创建和编辑技能文件。`,
        tools: [], // Will use inherited filesystem tools from parent agent
    };
}

/**
 * Get all subagents
 */
export function getSubagents(config: Config): SubAgent[] {
    return [
        createSkillWriterSubagent(config),
    ];
}
