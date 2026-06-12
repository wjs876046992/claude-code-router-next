import * as fs from 'fs';
import { getServiceInfo } from './processCheck';
import { getProjectConfigPath } from '@wengine-ai/claude-code-router-shared';

export async function showStatus() {
    const info = await getServiceInfo();

    console.log('\n📊 Claude Code Router Status');
    console.log('═'.repeat(40));

    if (info.running) {
        console.log('✅ Status: Running');
        console.log(`🆔 Process ID: ${info.pid}`);
        console.log(`🌐 Port: ${info.port}`);
        console.log(`📡 API Endpoint: ${info.endpoint}`);
        console.log(`📄 PID File: ${info.pidFile}`);
        console.log('');
        console.log('🚀 Ready to use! Run the following commands:');
        console.log('   ccr code    # Start coding with Claude');
        console.log('   ccr stop   # Stop the service');
    } else {
        console.log('❌ Status: Not Running');
        console.log('');
        console.log('💡 To start the service:');
        console.log('   ccr start');
    }

    console.log('');
    console.log('📁 Project-Level Configuration');
    console.log('─'.repeat(40));
    const projectConfigPath = getProjectConfigPath(process.cwd());
    console.log(`📂 Project: ${process.cwd()}`);
    if (fs.existsSync(projectConfigPath)) {
        console.log(`✅ Project config: ${projectConfigPath}`);
        console.log('   Run `ccr model --project` to view or update overrides');
    } else {
        console.log(`⚪ No project config (run \`ccr model --project\` to create one)`);
    }

    console.log('');
}
