import { Meteor } from 'meteor/meteor'
import { WebAppInternals } from 'meteor/webapp'
import type HTTP from 'http'
import { createWorkerFork } from './Workers';

if (Meteor.isDevelopment) {
    startViteServer();
}

function startViteServer() {
    const viteConfig = {
        host: 'localhost',
        port: 0,
        entryFile: '',
    }
    
    WebAppInternals.registerBoilerplateDataCallback('meteor-vite', (request: HTTP.IncomingMessage, data: BoilerplateData) => {
        const { host, port, entryFile } = viteConfig
        if (entryFile) {
            data.dynamicBody = `${data.dynamicBody || ""}\n<script type="module" src="http://${host}:${port}/${entryFile}"></script>\n`
        } else {
            // Vite not ready yet
            // Refresh page after some time
            data.dynamicBody = `${data.dynamicBody || ""}\n<script>setTimeout(() => location.reload(), 500)</script>\n`
        }
    })
    
    const worker = createWorkerFork({
        viteConfig(config) {
            Object.assign(viteConfig, config);
        }
    });
    
    worker.call('startViteDevServer');
}

interface BoilerplateData {
    dynamicBody: string;
}