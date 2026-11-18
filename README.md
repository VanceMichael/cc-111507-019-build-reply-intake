# 发布构建资料接口

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、字节摘要、来源元信息检查、结构化 CMake File API 收件和收件查询。结构化收件按客户请求定位回复对象，输出带配置与来源定位的目标资料。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

## 环境与运行

使用 Node.js 22.23.4。依赖通过 package-lock.json 锁定。准备环境时执行 `npm ci --ignore-scripts --no-audit --no-fund`，之后运行、构建、测试和演示均不下载资源。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址；服务绑定回环地址，来源网关与接收端在同一进程内使用独立端口。`DATA_DIR` 指定收件目录，默认 `./var`；`SCENARIO` 选择 fixtures/scenarios.json 中的来源场景。`npm run demo` 从临时空目录启动、实际领取来源字节、查询收件并退出，不回放旧日志。 `PORT` 可指定接收服务端口；未设置时仍自动选择空闲端口。

## 容器

```sh
docker build -t build-reply-intake:local .
docker run --rm --network none build-reply-intake:local npm test
docker run --rm --network none build-reply-intake:local npm run demo
```

镜像构建准备阶段完成依赖安装，运行不需要公网服务。接口约定见 `docs/接入约定.md`，来源格式范围见 `docs/来源格式.md`。`src/source-metadata.mjs` 只识别原始文件的元信息；结构化记录由 `src/cmake-file-api.mjs` 生成。文件收件与完整业务覆盖是不同状态。

## 结构化收件

`POST /v1/intakes` 使用 `{"mode": "structured", "client": "client-release"}` 领取 CMake File API 回复：按索引中找到的客户请求定位 codemodel，再读取各配置的目标文件，输出源码组、编译组及来源摘要。收件期间索引更新会按新索引重新收集，不拼接旧回复对象；缺失、越界与不一致写入 issues，state 据实为 complete、partial 或 rejected。服务只读取回复，不运行项目构建命令，也不检查生成路径是否已存在。

领域字段约定见 `docs/接入约定.md`；`npm test` 已覆盖标准、缺失目标、索引切换与客户错误等场景。
