import { Application } from '@nativescript/core';
import type { AndroidActivityResultEventData, AndroidActivityEventData } from '@nativescript/core';

const requestCode = 0xb711;
let choosing = false;

function chooseDocument(action: string, name?: string): Promise<android.net.Uri | null> {
  if (choosing) {
    return Promise.reject(new Error('请先完成当前文件选择'));
  }

  const activity = Application.android.foregroundActivity;

  if (!activity) {
    return Promise.reject(new Error('请返回应用后重试'));
  }

  const intent = new android.content.Intent(action);
  intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
  intent.setType('application/json');

  if (name) {
    intent.putExtra(android.content.Intent.EXTRA_TITLE, name);
  }

  choosing = true;

  return new Promise((resolve, reject) => {
    function cleanup() {
      choosing = false;
      Application.android.off('activityResult', result);
      Application.android.off('activityDestroyed', destroyed);
    }

    function destroyed(event: AndroidActivityEventData) {
      if (event.activity === activity) {
        cleanup();
        resolve(null);
      }
    }

    function result(event: AndroidActivityResultEventData) {
      if (event.requestCode !== requestCode) {
        return;
      }

      cleanup();
      resolve(
        event.resultCode === android.app.Activity.RESULT_OK
          ? (event.intent?.getData() ?? null)
          : null,
      );
    }

    Application.android.on('activityResult', result);
    Application.android.on('activityDestroyed', destroyed);

    try {
      activity.startActivityForResult(intent, requestCode);
    } catch (cause) {
      cleanup();
      reject(cause);
    }
  });
}

function fileOperation(
  run: (callback: com.bplaylist.mobile.FileCallback) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    run(
      new com.bplaylist.mobile.FileCallback({
        complete(value, error) {
          if (error) {
            reject(new Error(error));
          } else {
            resolve(value ?? '');
          }
        },
      }),
    );
  });
}

export async function openPlaylistFile() {
  const uri = await chooseDocument(android.content.Intent.ACTION_OPEN_DOCUMENT);

  if (!uri) {
    return null;
  }

  return fileOperation(callback =>
    com.bplaylist.mobile.PlaylistFiles.read(Application.android.context, uri, callback),
  );
}

export async function savePlaylistFile(title: string, text: string) {
  // eslint-disable-next-line no-control-regex -- 文件名需要过滤控制字符。
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'playlist';

  const uri = await chooseDocument(
    android.content.Intent.ACTION_CREATE_DOCUMENT,
    `${name}.bplaylist.json`,
  );

  if (!uri) {
    return false;
  }

  await fileOperation(callback =>
    com.bplaylist.mobile.PlaylistFiles.write(Application.android.context, uri, text, callback),
  );
  return true;
}
