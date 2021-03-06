'use babel'

import * as path from 'path'
import * as fs from 'fs'

export default class DelveConnection {
  constructor (spawn, connect, newSession, addOutputMessage, goconfig) {
    this._spawn = spawn
    this._connect = connect
    this._newSession = newSession
    this._addOutputMessage = addOutputMessage
    this._goconfig = goconfig
    this._session = null
  }

  start ({ config, file }) {
    if (this._session) {
      return Promise.reject('Already debugging!')
    }

    return new Promise((resolve, reject) => {
      const { mode } = config
      const { host, port } = hostAndPort(config)

      let client
      let proc
      let canceled = false

      const connect = () => {
        if (client) {
          return
        }
        client = 'creating ...'

        // add a slight delay so that issues of delve while starting will
        // exit delve and therefore cancel the debug session
        setTimeout(() => {
          if (canceled) {
            return
          }
          this._connect(port, host)
            .then((conn) => {
              this._session = this._newSession(proc, conn, mode)
              this._session.addOutputMessage = this._addOutputMessage
              resolve(this._session)
            })
            .catch(reject)
        }, 250)
      }

      const prepare = () => {
        const variables = getVariables(file)
        updateEnv(config, variables, this._goconfig)
        const cwd = getCwd(config, variables)

        return getDlvArgs(config, variables).then((dlvArgs) => {
          return {
            dlvArgs,
            cwd,
            env: variables.env
          }
        })
      }

      const start = ({ dlvArgs, cwd, env }) => {
        proc = this._spawn(dlvArgs, { cwd, env })

        proc.stderr.on('data', (chunk) => {
          this._addOutputMessage('debug', 'Delve output: ' + chunk.toString())
          connect()
        })
        proc.stdout.on('data', (chunk) => {
          this._addOutputMessage('debug', chunk.toString())
          connect()
        })

        const close = () => {
          proc.kill()
          this.dispose()
          canceled = true
        }

        proc.on('close', (code) => {
          this._addOutputMessage('debug', 'delve closed with code ' + (code || 0))
          close()
          if (code) {
            reject('Closed with code ' + code)
          }
        })
        proc.on('error', (err) => {
          this._addOutputMessage('debug', 'error: ' + (err || ''))
          close()
          reject(err)
        })
      }

      if (mode === 'remote') {
        // delve is already running on a remote machine.
        // just connect to it using the host and port.
        connect()
        return
      }

      prepare().then(start)
    })
  }

  dispose () {
    if (this._session) {
      this._session.stop()
      this._session = null
    }
    return Promise.resolve()
  }
}

const regexVariable = /\${(.*?)}/g

function replaceVariable (value, variables) {
  return value.replace(regexVariable, (group, name) => {
    if (name.startsWith('env.')) {
      return variables.env[name.replace('env.', '')]
    }
    return variables[name]
  })
}

function getVariables (file) {
  return {
    cwd: process.cwd(),                                  // the working directory on startup of atom
    file,                                                // the open file (full path)
    fileBasename: file && path.basename(file),           // the open file's basename
    fileDirname: file && path.dirname(file),             // the open file's dirname
    fileExtname: file && path.extname(file),             // the open file's extension
    relativeFile: file && atom.project.relativize(file), // the open file relative to the "workspaceRoot" variable
    workspaceRoot: atom.project.getPaths()[0]            // the full path of the project root folder
  }
}

function updateEnv (config, variables, goconfig) {
  // already assign the already known environment variables here so they can be used by the `config.env` values
  variables.env = goconfig.environment()

  const env = Object.assign({}, variables.env)
  const configEnv = config.env
  if (configEnv) {
    for (var key in configEnv) {
      if (configEnv.hasOwnProperty(key)) {
        env[key] = replaceVariable(configEnv[key], variables)
      }
    }
  }
  variables.env = env
}

const SERVER_URL = 'localhost'
const SERVER_PORT = 2345

function hostAndPort (config) {
  const { host = SERVER_URL, port = SERVER_PORT } = config
  return { host, port }
}

function getDlvArgs (config, variables) {
  const { mode, program, showLog = false, buildFlags, init: dlvInit, args } = config
  const { host, port } = hostAndPort(config)
  const dlvArgs = [mode || 'debug']

  let prom = Promise.resolve()
  if (mode === 'attach') {
    prom = attach().then((processID) => {
      dlvArgs.push(processID)
    })
  }

  return prom.then(() => {
    if (mode === 'exec') {
      // debug a pre compiled executable
      dlvArgs.push(replaceVariable(program, variables))
    }
    dlvArgs.push(
      '--headless=true',
      `--listen=${host}:${port}`,
      '--api-version=2'
    )
    if (showLog) {
      // turn additional delve logging on or off
      dlvArgs.push('--log=' + showLog.toString())
    }
    if (buildFlags) {
      // add additional build flags to delve
      dlvArgs.push('--build-flags=' + buildFlags)
    }
    if (dlvInit) {
      // used to execute some commands when delve starts
      dlvArgs.push('--init=' + replaceVariable(dlvInit, variables))
    }
    if (args) {
      dlvArgs.push('--', ...args.map((v) => replaceVariable(v, variables)))
    }

    return dlvArgs
  })
}

function attach () {
  return new Promise((resolve, reject) => {
    const item = document.createElement('div')
    item.innerHTML = '<p>Process ID:</p>' +
      '<input type="text" class="go-debug-attach-input native-key-bindings" />' +
      '<button type="button" class="go-debug-attach-btn btn">OK</button>'

    const panel = atom.workspace.addModalPanel({ item })

    const input = item.querySelector('.go-debug-attach-input')
    input.focus()

    item.querySelector('.go-debug-attach-btn').addEventListener('click', () => {
      panel.destroy()
      const { value } = input
      if (value) {
        resolve(value)
      }
    })
  })
}

function getCwd (config, variables) {
  let { cwd } = config
  if (cwd) {
    return replaceVariable(cwd, variables)
  }
  let file = variables.file
  try {
    if (fs.lstatSync(file).isDirectory()) {
      cwd = file // assume it is a package...
    }
  } catch (e) {
    // ...
  }
  if (!cwd) {
    cwd = path.dirname(file)
  }
  return cwd
}
