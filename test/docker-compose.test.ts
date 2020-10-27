import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs-extra';
import { Project, DockerCompose, DockerComposeProtocol } from '../src';
import * as logging from '../src/logging';

logging.disable();

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(__dirname, 'tmp.docker-compose'));
});

afterEach(() => {
  if (tempDir) {
    fs.removeSync(tempDir);
  }
});

describe('docker-compose', () => {
  test('errors when no services', () => {
    const project = new Project();
    new DockerCompose(project);

    expect(() => project.synth(tempDir))
      .toThrow(/at least one service/i);
  });

  test('errors when imageBuild and image not specified in service', () => {
    const project = new Project();
    const dc = new DockerCompose(project);

    expect(() => dc.addService('service', {}))
      .toThrow(/requires exactly one of.*imageBuild.*image/i);
  });

  test('errors when imageBuild and image are both specified in service', () => {
    const project = new Project();
    const dc = new DockerCompose(project);

    expect(() => dc.addService('service', {
      image: 'nginx',
      imageBuild: {
        context: '.',
      },
    })).toThrow(/requires exactly one of.*imageBuild.*image/i);
  });

  test('can build an image', () => {
    const project = new Project();

    const dc = new DockerCompose(project, {
      services: {
        custom: {
          imageBuild: {
            context: '.',
            dockerfile: 'docker-compose.test.Dockerfile',
            args: {
              FROM: 'alpine',
            },
          },
          command: ['sh', '-c', 'echo hi'],
        },
      },
    });

    expect(dc._synthesizeDockerCompose()).toEqual({
      services: {
        custom: {
          build: {
            context: '.',
            dockerfile: 'docker-compose.test.Dockerfile',
            args: {
              FROM: 'alpine',
            },
          },
          command: ['sh', '-c', 'echo hi'],
        },
      },
    });

    project.synth(tempDir);
    assertDockerComposeFileValidates(tempDir);
  });

  test('can choose a name suffix for the docker-compose.yml', () => {
    const project = new Project();
    new DockerCompose(project, {
      nameSuffix: 'myname',
      services: {
        myservice: {
          image: 'nginx',
        },
      },
    });

    project.synth(tempDir);
    expect(fs.existsSync(path.join(tempDir, 'docker-compose.myname.yml')));
  });

  test('can add a container command', () => {
    const project = new Project();
    const dc = new DockerCompose(project, {
      services: {
        alpine: {
          image: 'alpine',
          command: ['sh', '-c', 'echo I ran'],
        },
      },
    });

    expect(dc._synthesizeDockerCompose()).toEqual({
      services: {
        alpine: {
          image: 'alpine',
          command: ['sh', '-c', 'echo I ran'],
        },
      },
    });

    project.synth(tempDir);
    assertDockerComposeFileValidates(tempDir);
  });

  describe('can add a volume', () => {
    test('bind volume', () => {
      const project = new Project();
      const dc = new DockerCompose(project, {
        services: {
          myservice: {
            image: 'nginx',
            volumes: [
              DockerCompose.bindVolume('./docroot', '/var/www/html'),
            ],
          },
        },
      });

      expect(dc._synthesizeDockerCompose()).toEqual({
        services: {
          myservice: {
            image: 'nginx',
            volumes: [
              {
                type: 'bind',
                source: './docroot',
                target: '/var/www/html',
              },
            ],
          },
        },
      });

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });

    test('named volume', () => {
      const project = new Project();
      const dc = new DockerCompose(project, {
        services: {
          myservice: {
            image: 'nginx',
            volumes: [
              DockerCompose.namedVolume('html', '/var/www/html'),
            ],
          },
        },
      });

      expect(dc._synthesizeDockerCompose()).toEqual({
        services: {
          myservice: {
            image: 'nginx',
            volumes: [
              {
                type: 'volume',
                source: 'html',
                target: '/var/www/html',
              },
            ],
          },
        },
        volumes: {
          html: {},
        },
      });

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });

    test('named volume with special driver', () => {
      const project = new Project();
      const dc = new DockerCompose(project, {
        services: {
          web: {
            image: 'nginx',
            volumes: [
              DockerCompose.namedVolume('web', '/var/www/html', {
                driverOpts: {
                  type: 'nfs',
                  o: 'addr=10.40.0.199,nolock,soft,rw',
                  device: ':/docker/example',
                },
              }),
            ],
          },
        },
      });

      expect(dc._synthesizeDockerCompose()).toEqual({
        services: {
          web: {
            image: 'nginx',
            volumes: [
              {
                type: 'volume',
                source: 'web',
                target: '/var/www/html',
              },
            ],
          },
        },
        volumes: {
          web: {
            driver_opts: {
              type: 'nfs',
              o: 'addr=10.40.0.199,nolock,soft,rw',
              device: ':/docker/example',
            },
          },
        },
      });

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });

    test('imperatively', () => {
      const project = new Project();
      const dc = new DockerCompose(project);

      const service = dc.addService('myservice', {
        image: 'nginx',
      });
      service.addVolume(DockerCompose.namedVolume('html', '/var/www/html'));

      expect(dc._synthesizeDockerCompose()).toEqual({
        services: {
          myservice: {
            image: 'nginx',
            volumes: [
              {
                type: 'volume',
                source: 'html',
                target: '/var/www/html',
              },
            ],
          },
        },
        volumes: {
          html: {},
        },
      });

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });
  });

  describe('can map a port', () => {
    const expected = {
      services: {
        port: {
          image: 'nginx',
          ports: [
            {
              published: 8080,
              target: 80,
              protocol: 'tcp',
              mode: 'host',
            },
            {
              published: 8080,
              target: 80,
              protocol: 'udp',
              mode: 'host',
            },
          ],
        },
      },
    };

    test('declaratively', () => {
      const project = new Project();
      const dc = new DockerCompose(project, {
        services: {
          port: {
            image: 'nginx',
            ports: [
              DockerCompose.portMapping(8080, 80),
              DockerCompose.portMapping(8080, 80, {
                protocol: DockerComposeProtocol.UDP,
              }),
            ],
          },
        },
      });

      expect(dc._synthesizeDockerCompose()).toEqual(expected);

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });

    test('imperatively', () => {
      const project = new Project();
      const dc = new DockerCompose(project);

      const service = dc.addService('port', {
        image: 'nginx',
      });

      service.addPort(8080, 80);
      service.addPort(8080, 80, {
        protocol: DockerComposeProtocol.UDP,
      });

      expect(dc._synthesizeDockerCompose()).toEqual(expected);

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });
  });

  describe('can add depends_on', () => {
    const expected = {
      services: {
        first: { image: 'alpine' },
        second: {
          depends_on: ['first'],
          image: 'nginx',
        },
      },
    };

    test('declaratively', () => {
      const project = new Project();
      const dc = new DockerCompose(project, {
        services: {
          first: { image: 'alpine' },
          second: {
            dependsOn: [DockerCompose.serviceName('first')],
            image: 'nginx',
          },
        },
      });

      expect(dc._synthesizeDockerCompose()).toEqual(expected);

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });

    test('imperatively', () => {
      const project = new Project();
      const dc = new DockerCompose(project);

      const first = dc.addService('first', { image: 'alpine' });
      const second = dc.addService('second', { image: 'nginx' });
      second.addDependsOn(first);

      expect(dc._synthesizeDockerCompose()).toEqual(expected);

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });
  });

  describe('can add environment variables', () => {
    const expected = {
      services: {
        www: {
          image: 'nginx',
          environment: {
            FOO: 'bar',
            Baz: 'xyz',
          },
        },
      },
    };

    test('declaratively', () => {
      const project = new Project();
      const dc = new DockerCompose(project, {
        services: {
          www: {
            image: 'nginx',
            environment: {
              FOO: 'bar',
              Baz: 'xyz',
            },
          },
        },
      });

      expect(dc._synthesizeDockerCompose()).toEqual(expected);

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });

    test('imperatively', () => {
      const project = new Project();
      const dc = new DockerCompose(project);

      const service = dc.addService('www', {
        image: 'nginx',
      });

      service.addEnvironment('FOO', 'bar');
      service.addEnvironment('Baz', 'xyz');

      expect(dc._synthesizeDockerCompose()).toEqual(expected);

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });
  });

  test('errors when a service reference by name does not exist', () => {
    const project = new Project();

    new DockerCompose(project, {
      services: {
        www: {
          image: 'nginx',
          dependsOn: [DockerCompose.serviceName('nope')],
        },
      },
    });

    expect(() => project.synth(tempDir))
      .toThrow(/unable to resolve.*nope.*www/i);
  });

  test('errors when a service depends on itself', () => {
    const project = new Project();

    new DockerCompose(project, {
      services: {
        www: {
          image: 'nginx',
          dependsOn: [DockerCompose.serviceName('www')],
        },
      },
    });

    expect(() => project.synth(tempDir))
      .toThrow(/depend on itself/i);
  });

  describe('can create a wordpress dev env', () => {
    const expected = {
      services: {
        setup: {
          image: 'alpine',
          command: ['sh', '-c', 'chmod a+w -R /uploads'],
          volumes: [
            {
              type: 'volume',
              source: 'uploads',
              target: '/uploads',
            },
          ],
        },
        db: {
          image: 'mysql:8',
          volumes: [
            {
              type: 'volume',
              source: 'database',
              target: '/var/lib/mysql',
            },
          ],
          environment: {
            MYSQL_RANDOM_ROOT_PASSWORD: '1',
            MYSQL_USER: 'wpuser',
            MYSQL_PASSWORD: 'wppass',
            MYSQL_DATABASE: 'wp',
          },
        },
        wordpress: {
          image: 'wordpress:php7.4-apache',
          depends_on: ['db', 'setup'],
          volumes: [
            {
              source: 'uploads',
              target: '/var/www/html/wp-content/uploads',
              type: 'volume',
            },
            {
              source: 'docroot',
              target: '/var/www/html',
              type: 'volume',
            },
            {
              source: 'plugins',
              target: '/var/www/html/wp-content/plugins',
              type: 'volume',
            },
            {
              source: 'themes',
              target: '/var/www/html/wp-content/themes',
              type: 'volume',
            },
          ],
          ports: [
            {
              mode: 'host',
              published: 8081,
              target: 80,
              protocol: 'tcp',
            },
          ],
          environment: {
            WORDPRESS_DB_HOST: 'db',
            WORDPRESS_DB_USER: 'wpuser',
            WORDPRESS_DB_PASSWORD: 'wppass',
            WORDPRESS_DB_NAME: 'wp',
          },
        },
      },
      volumes: {
        database: {},
        docroot: {},
        plugins: {},
        themes: {},
        uploads: {},
      },
    };

    test('declaratively', () => {
      const project = new Project();
      const dc = new DockerCompose(project, {
        services: {
          setup: {
            image: 'alpine',
            command: ['sh', '-c', 'chmod a+w -R /uploads'],
            volumes: [
              DockerCompose.namedVolume('uploads', '/uploads'),
            ],
          },
          db: {
            image: 'mysql:8',
            volumes: [
              DockerCompose.namedVolume('database', '/var/lib/mysql'),
            ],
            environment: {
              MYSQL_RANDOM_ROOT_PASSWORD: '1',
              MYSQL_USER: 'wpuser',
              MYSQL_PASSWORD: 'wppass',
              MYSQL_DATABASE: 'wp',
            },
          },
          wordpress: {
            dependsOn: [
              DockerCompose.serviceName('db'),
              DockerCompose.serviceName('setup'),
            ],
            image: 'wordpress:php7.4-apache',
            ports: [
              DockerCompose.portMapping(8081, 80),
            ],
            volumes: [
              DockerCompose.namedVolume('uploads', '/var/www/html/wp-content/uploads'),
              DockerCompose.namedVolume('docroot', '/var/www/html'),
              DockerCompose.namedVolume('plugins', '/var/www/html/wp-content/plugins'),
              DockerCompose.namedVolume('themes', '/var/www/html/wp-content/themes'),
            ],
            environment: {
              WORDPRESS_DB_HOST: 'db',
              WORDPRESS_DB_USER: 'wpuser',
              WORDPRESS_DB_PASSWORD: 'wppass',
              WORDPRESS_DB_NAME: 'wp',
            },
          },
        },
      });

      expect(dc._synthesizeDockerCompose()).toEqual(expected);

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });

    test('imperatively', () => {
      const project = new Project();
      const dc = new DockerCompose(project);

      const setup = dc.addService('setup', {
        image: 'alpine',
        command: ['sh', '-c', 'chmod a+w -R /uploads'],
        volumes: [
          DockerCompose.namedVolume('uploads', '/uploads'),
        ],
      });

      const db = dc.addService('db', {
        image: 'mysql:8',
        volumes: [
          DockerCompose.namedVolume('database', '/var/lib/mysql'),
        ],
        environment: {
          MYSQL_RANDOM_ROOT_PASSWORD: '1',
          MYSQL_USER: 'wpuser',
          MYSQL_PASSWORD: 'wppass',
          MYSQL_DATABASE: 'wp',
        },
      });

      const wp = dc.addService('wordpress', {
        dependsOn: [db],
        image: 'wordpress:php7.4-apache',
        ports: [
          DockerCompose.portMapping(8081, 80),
        ],
        volumes: [
          DockerCompose.namedVolume('uploads', '/var/www/html/wp-content/uploads'),
        ],
        environment: {
          WORDPRESS_DB_HOST: 'db',
          WORDPRESS_DB_USER: 'wpuser',
          WORDPRESS_DB_PASSWORD: 'wppass',
          WORDPRESS_DB_NAME: 'wp',
        },
      });

      wp.addDependsOn(setup);
      wp.addVolume(DockerCompose.namedVolume('docroot', '/var/www/html'));
      wp.addVolume(DockerCompose.namedVolume('plugins', '/var/www/html/wp-content/plugins'));
      wp.addVolume(DockerCompose.namedVolume('themes', '/var/www/html/wp-content/themes'));

      expect(dc._synthesizeDockerCompose()).toEqual(expected);

      project.synth(tempDir);
      assertDockerComposeFileValidates(tempDir);
    });
  });
});

const hasDockerCompose = child_process.spawnSync('docker-compose', ['version']).status === 0;

function assertDockerComposeFileValidates(dir: string) {
  const filePath = path.join(dir, 'docker-compose.yml');
  expect(fs.existsSync(filePath)).toBeTruthy();

  if (hasDockerCompose) {
    const res = child_process.spawnSync('docker-compose', ['-f', filePath, 'config']);
    if (res.status !== 0) {
      throw new Error(`docker-compose file does not validate: ${res.stderr.toString()}`);
    }
  } else {
    console.warn('docker-compose is not present, so we cannot validate via client');
  }
}