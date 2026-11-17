# 发布构建资料接口

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、字节摘要、来源元信息检查、CMake File API 结构化收件和收件查询。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

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

镜像构建准备阶段完成依赖安装，运行不需要公网服务。接口约定见 `docs/接入约定.md`，来源格式范围见 `docs/来源格式.md`。`src/source-metadata.mjs` 只识别文件元信息，不代表已提取结构化记录；结构化解析由 `src/cmake-intake.mjs` 承担。文件收件与完整业务覆盖是不同状态。

## 结构化方式检查

结构化收件已开放：`POST /v1/intakes` 传 `{"mode":"structured","client":"client-release"}`，服务按客户自己的 query.json 回复定位 CMake File API codemodel v2 对象，输出逐配置目标资料（源码组、编译组分开），并对引用缺失、客户级错误、索引漂移和未出现的生成路径如实登记 issue。运行 `STRUCTURED=1 npm test` 与默认 `npm test` 都会执行该检查；完整性规则见接入文档，不以测试代替支持范围说明。
