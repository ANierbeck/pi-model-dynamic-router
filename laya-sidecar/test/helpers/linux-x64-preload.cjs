// Test-only preload: makes onnxruntime-node's install script believe it runs on
// linux/x64, where it downloads the CUDA execution-provider libraries. The
// download is pointed at a closed proxy by the caller, so nothing leaves the machine.
const os = require('node:os');
Object.defineProperty(process, 'platform', { value: 'linux' });
os.platform = () => 'linux';
os.arch = () => 'x64';
