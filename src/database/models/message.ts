import { DeepPartial } from 'utility-types';

import { BaseModel } from '@/database/core';
import { DBModel } from '@/database/core/types/db';
import { DB_Message, DB_MessageSchema } from '@/database/schemas/message';
import { ChatMessage } from '@/types/message';
import { nanoid } from '@/utils/uuid';

export interface CreateMessageParams
  extends Partial<Omit<ChatMessage, 'content' | 'role'>>,
    Pick<ChatMessage, 'content' | 'role'> {
  fromModel?: string;
  sessionId: string;
}

export interface QueryMessageParams {
  current?: number;
  pageSize?: number;
  sessionId: string;
  topicId?: string;
}

class _MessageModel extends BaseModel {
  constructor() {
    super('messages', DB_MessageSchema);
  }
  async create(data: CreateMessageParams) {
    const id = nanoid();

    const messageData: DB_Message = this.mapChatMessageToDBMessage(data as ChatMessage);

    return this._add(messageData, id);
  }

  async batchCreate(messages: ChatMessage[]) {
    const data: DB_Message[] = messages.map((m) => this.mapChatMessageToDBMessage(m));

    return this._batchAdd(data);
  }

  async query({
    sessionId,
    topicId,
    pageSize = 9999,
    current = 0,
  }: QueryMessageParams): Promise<ChatMessage[]> {
    const offset = current * pageSize;

    const query =
      topicId !== undefined
        ? // TODO: The query {"sessionId":"xxx","topicId":"xxx"} on messages would benefit of a compound index [sessionId+topicId]
          this.table.where({ sessionId, topicId }) // Use a compound index
        : this.table
            .where('sessionId')
            .equals(sessionId)
            .and((message) => !message.topicId);

    const dbMessages: DBModel<DB_Message>[] = await query
      .sortBy('createdAt')
      // handle page size
      .then((sortedArray) => sortedArray.slice(offset, offset + pageSize));

    const messages = dbMessages.map((msg) => this.mapToChatMessage(msg));

    const finalList: ChatMessage[] = [];

    const addItem = (item: ChatMessage) => {
      const isExist = finalList.findIndex((i) => item.id === i.id) > -1;
      if (!isExist) {
        finalList.push(item);
      }
    };
    const messageMap = new Map<string, ChatMessage>();
    for (const item of messages) messageMap.set(item.id, item);

    for (const item of messages) {
      if (!item.parentId || !messageMap.has(item.parentId)) {
        // 如果消息没有父消息或者父消息不在列表中，直接添加
        addItem(item);
      } else {
        // 如果消息有父消息，确保先添加父消息
        addItem(messageMap.get(item.parentId)!);
        addItem(item);
      }
    }
    return finalList;
  }

  async findById(id: string): Promise<DBModel<DB_Message>> {
    return this.table.get(id);
  }

  async delete(id: string) {
    return this.table.delete(id);
  }

  async clearTable() {
    return this.table.clear();
  }

  async update(id: string, data: DeepPartial<DB_Message>) {
    const { content: message, ...rest } = data;
    const ids = {
      conversation_id: undefined,
      parent_message_id: undefined,
    };

    // let pattern = /\{"conversation_id":"[\da-z-]+","parent_message_id":"[\da-z-]+"\}/;
    let pattern = /{"conversation_id":"[\da-z-]+","parent_message_id":"[\da-z-]+"}/;
    // let pattern = /\{conversation_id: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", parent_message_id: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"\}/;
    let modifiedText = '';
    if (message) {
      // 使用replace方法将匹配到的部分替换为空
      modifiedText = message.replace(pattern, '');
      const matchedPart = message.match(pattern)?.[0];
      if (matchedPart) {
        const parseJSON = JSON.parse(matchedPart || '');
        Object.assign(ids, parseJSON);
      }
    }
    return super._update(id, {
      content: modifiedText,
      ...ids,
      ...rest,
    });
  }

  /**
   * Batch updates multiple fields of the specified messages.
   *
   * @param {string[]} messageIds - The identifiers of the messages to be updated.
   * @param {Partial<DB_Message>} updateFields - An object containing the fields to update and their new values.
   * @returns {Promise<number>} - The number of updated messages.
   */
  async batchUpdate(messageIds: string[], updateFields: Partial<DB_Message>): Promise<number> {
    // Retrieve the messages by their IDs
    const messagesToUpdate = await this.table.where(':id').anyOf(messageIds).toArray();

    // Update the specified fields of each message
    const updatedMessages = messagesToUpdate.map((message) => ({
      ...message,
      ...updateFields,
    }));

    // Use the bulkPut method to update the messages in bulk
    await this.table.bulkPut(updatedMessages);

    return updatedMessages.length;
  }

  /**
   * Deletes multiple messages based on the assistantId and optionally the topicId.
   * If topicId is not provided, it deletes messages where topicId is undefined.
   * If topicId is provided, it deletes messages with that specific topicId.
   *
   * @param {string} sessionId - The identifier of the assistant associated with the messages.
   * @param {string | undefined} topicId - The identifier of the topic associated with the messages (optional).
   * @returns {Promise<void>}
   */
  async batchDelete(sessionId: string, topicId: string | undefined): Promise<void> {
    // If topicId is specified, use both assistantId and topicId as the filter criteria in the query.
    // Otherwise, filter by assistantId and require that topicId is undefined.
    const query =
      topicId !== undefined
        ? this.table.where({ sessionId, topicId }) // Use a compound index
        : this.table
            .where('sessionId')
            .equals(sessionId)
            .and((message) => message.topicId === undefined);

    // Retrieve a collection of message IDs that satisfy the criteria
    const messageIds = await query.primaryKeys();

    // Use the bulkDelete method to delete all selected messages in bulk
    return this.table.bulkDelete(messageIds);
  }

  async queryAll() {
    const data: DBModel<DB_Message>[] = await this.table.orderBy('updatedAt').toArray();

    return data.map((element) => this.mapToChatMessage(element));
  }

  async isEmpty() {
    const count = await this.table.count();

    return count === 0;
  }

  async queryBySessionId(sessionId: string) {
    return this.table.where('sessionId').equals(sessionId).toArray();
  }

  queryByTopicId = async (topicId: string) => {
    const dbMessages = await this.table.where('topicId').equals(topicId).toArray();

    return dbMessages.map((message) => this.mapToChatMessage(message));
  };

  async duplicateMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
    const duplicatedMessages = await this.createDuplicateMessages(messages);
    // 批量添加复制后的消息到数据库
    await this.batchCreate(duplicatedMessages);
    return duplicatedMessages;
  }

  async createDuplicateMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
    // 创建一个映射来存储原始消息ID和复制消息ID之间的关系
    const idMapping = new Map<string, string>();

    // 首先复制所有消息，并为每个复制的消息生成新的ID
    const duplicatedMessages = messages.map((originalMessage) => {
      const newId = nanoid();
      idMapping.set(originalMessage.id, newId);

      return { ...originalMessage, id: newId };
    });

    // 更新 parentId 为复制后的新ID
    for (const duplicatedMessage of duplicatedMessages) {
      if (duplicatedMessage.parentId && idMapping.has(duplicatedMessage.parentId)) {
        duplicatedMessage.parentId = idMapping.get(duplicatedMessage.parentId);
      }
    }

    return duplicatedMessages;
  }

  private mapChatMessageToDBMessage(message: ChatMessage): DB_Message {
    const { extra, ...messageData } = message;

    return { ...messageData, ...extra } as DB_Message;
  }

  private mapToChatMessage = ({
    fromModel,
    translate,
    tts,
    ...item
  }: DBModel<DB_Message>): ChatMessage => {
    return { ...item, extra: { fromModel, translate, tts }, meta: {} };
  };
}

export const MessageModel = new _MessageModel();
