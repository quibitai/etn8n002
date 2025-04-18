// This file forwards requests to the actual route implementation
// to fix routing issues in production deployments

import type { NextRequest } from 'next/server';
import type { UIMessage } from 'ai';
import {
  appendResponseMessages,
  createDataStreamResponse,
  smoothStream,
  streamText,
} from 'ai';
import { auth } from '@/app/(auth)/auth';
import { systemPrompt } from '@/lib/ai/prompts';
import {
  deleteChatById,
  getChatById,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import {
  generateUUID,
  getMostRecentUserMessage,
  getTrailingMessageId,
} from '@/lib/utils';
import { generateTitleFromUserMessage } from '@/app/(chat)/actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { listDocuments } from '@/lib/ai/tools/list-documents';
import { retrieveDocument } from '@/lib/ai/tools/retrieve-document';
import { queryDocumentRows } from '@/lib/ai/tools/query-document-rows';
import { tavilySearch } from '@/lib/ai/tools/tavily-search';
import { searchInternalKnowledgeBase } from '@/lib/ai/tools/search-internal-knowledge-base';
import { googleCalendar } from '@/lib/ai/tools/google-calendar';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    // Log the raw body first
    const rawRequestBody = await request.clone().text(); // Clone request to read body without consuming it
    console.log('[NEXT_STEP_DEBUG] Raw Request Body:', rawRequestBody);

    // Parse the JSON manually to inspect before destructuring
    const requestData = JSON.parse(rawRequestBody);
    console.log(
      '[NEXT_STEP_DEBUG] Parsed Request Data:',
      JSON.stringify(requestData),
    );

    // Use the manually parsed data instead of parsing the request again
    const {
      id,
      messages,
      selectedChatModel,
    }: {
      id: string;
      messages: Array<UIMessage>;
      selectedChatModel: string;
    } = requestData;

    console.log('[DEBUG] Checking N8N Environment Variables:');
    console.log(
      '[DEBUG] N8N_EXTRACT_WEBHOOK_URL:',
      process.env.N8N_EXTRACT_WEBHOOK_URL ? 'Defined' : 'MISSING!',
    );
    console.log(
      '[DEBUG] N8N_EXTRACT_AUTH_HEADER:',
      process.env.N8N_EXTRACT_AUTH_HEADER ? 'Defined' : 'MISSING!',
    );
    console.log(
      '[DEBUG] N8N_EXTRACT_AUTH_TOKEN:',
      process.env.N8N_EXTRACT_AUTH_TOKEN ? 'Defined' : 'MISSING!',
    );
    console.log(
      '[DEBUG] N8N_GOOGLE_CALENDAR_WEBHOOK_URL:',
      process.env.N8N_GOOGLE_CALENDAR_WEBHOOK_URL ? 'Defined' : 'MISSING!',
    );
    console.log(
      '[DEBUG] N8N_GOOGLE_CALENDAR_AUTH_HEADER:',
      process.env.N8N_GOOGLE_CALENDAR_AUTH_HEADER ? 'Defined' : 'MISSING!',
    );
    console.log(
      '[DEBUG] N8N_GOOGLE_CALENDAR_AUTH_TOKEN:',
      process.env.N8N_GOOGLE_CALENDAR_AUTH_TOKEN ? 'Defined' : 'MISSING!',
    );

    const session = await auth();

    if (!session || !session.user || !session.user.id) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Get environment variables for n8n integration
    const n8nWebhookUrl = process.env.N8N_RAG_TOOL_WEBHOOK_URL;
    const n8nAuthHeader = process.env.N8N_RAG_TOOL_AUTH_HEADER;
    const n8nAuthToken = process.env.N8N_RAG_TOOL_AUTH_TOKEN;

    if (!n8nWebhookUrl || !n8nAuthHeader || !n8nAuthToken) {
      console.error('Missing n8n configuration environment variables');
      return new Response('Server configuration error', { status: 500 });
    }

    const userMessage = getMostRecentUserMessage(messages);

    if (!userMessage) {
      return new Response('No user message found', { status: 400 });
    }

    // Extract attachments from the user message, defaulting to an empty array
    const attachmentsToProcess = userMessage.experimental_attachments || [];

    // Log the correctly extracted attachments
    console.log(
      '[CORRECTED_DEBUG] Attachments found in user message:',
      JSON.stringify(attachmentsToProcess),
    );
    console.log(
      '[CORRECTED_DEBUG] Number of attachments to process:',
      attachmentsToProcess.length,
    );

    const chat = await getChatById({ id });

    if (!chat) {
      const title = await generateTitleFromUserMessage({
        message: userMessage,
      });

      await saveChat({ id, userId: session.user.id, title });
    } else {
      if (chat.userId !== session.user.id) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: userMessage.id,
          role: 'user',
          parts: userMessage.parts,
          attachments: userMessage.experimental_attachments ?? [],
          createdAt: new Date(),
        },
      ],
    });

    // Process file attachments if they exist
    const contextFileContents = [];
    if (attachmentsToProcess && attachmentsToProcess.length > 0) {
      console.log(
        `[CORRECTED_DEBUG] Entering attachments loop (${attachmentsToProcess.length} attachments)...`,
      );
      console.log(
        `Processing ${attachmentsToProcess.length} attached files for context`,
      );

      // Fetch content for each file
      for (const file of attachmentsToProcess) {
        console.log(`[CORRECTED_DEBUG] Looping for file: ${file.name}`);
        console.log(
          `[DEBUG] Processing file: ${file.name}, Type: ${file.contentType}, URL: ${file.url}`,
        );

        let content = `[Attachment: ${file.name}]`; // Default placeholder
        const contentType = file.contentType?.toLowerCase() || '';

        // Define content types to be handled by n8n workflow
        const n8nHandledTypes = [
          'pdf', // application/pdf
          'spreadsheetml.sheet', // .xlsx
          'ms-excel', // .xls
          'csv', // text/csv
          'json', // application/json
          'text/plain', // .txt
          'text/markdown', // .md
          // Add other specific non-image types n8n handles here
        ];

        // Check if the current file type should be processed by n8n
        const shouldCallN8n = n8nHandledTypes.some((type) =>
          contentType.includes(type),
        );

        // Check if it's an image type (to keep existing handling)
        const isImage = contentType.startsWith('image/');

        console.log(`[DEBUG] ContentType Lowercase: ${contentType}`);
        console.log(`[DEBUG] Is Image? ${isImage}`);
        console.log(`[DEBUG] Should call n8n? ${shouldCallN8n}`);

        // --- Start Conditional Processing ---

        if (shouldCallN8n) {
          // --- n8n Webhook Call Logic ---
          const n8nWebhookUrl = process.env.N8N_EXTRACT_WEBHOOK_URL;
          const n8nAuthHeader = process.env.N8N_EXTRACT_AUTH_HEADER;
          const n8nAuthToken = process.env.N8N_EXTRACT_AUTH_TOKEN;

          console.log(
            `[DEBUG] N8N Config Check Inside Loop: URL=${!!n8nWebhookUrl}, Header=${!!n8nAuthHeader}, Token=${!!n8nAuthToken}`,
          );

          if (n8nWebhookUrl && n8nAuthHeader && n8nAuthToken) {
            console.log(
              `Calling n8n to extract content for: ${file.name} (${contentType})`,
            );

            console.log(
              `[DEBUG] Attempting to call n8n webhook at: ${n8nWebhookUrl}`,
            );

            try {
              const headers: Record<string, string> = {
                'Content-Type': 'application/json',
              };
              headers[n8nAuthHeader] = n8nAuthToken;

              const body = JSON.stringify({
                fileUrl: file.url,
                contentType: file.contentType,
              });

              console.log('[DEBUG] Fetch Headers:', JSON.stringify(headers)); // Stringify to see the structure clearly
              console.log('[DEBUG] Fetch Body:', body);

              const n8nResponse = await fetch(n8nWebhookUrl, {
                method: 'POST',
                headers: headers,
                body: body,
              });

              console.log(
                `[DEBUG] N8N response status for ${file.name}: ${n8nResponse.status}`,
              );

              if (n8nResponse.ok) {
                const n8nResult = await n8nResponse.json();
                console.log(
                  `[DEBUG] N8N Success Response Body for ${file.name}:`,
                  JSON.stringify(n8nResult),
                );

                // Adjust based on n8n 'Respond to Webhook' -> 'Put Response in Field' setting
                if (
                  n8nResult.responseBody?.success &&
                  n8nResult.responseBody?.extractedText
                ) {
                  content = n8nResult.responseBody.extractedText;

                  // Check if the content appears to be JSON
                  if (
                    content.trim().startsWith('[') ||
                    content.trim().startsWith('{')
                  ) {
                    try {
                      // Parse JSON and format into readable text
                      const jsonData = JSON.parse(content);

                      // Handle array of objects (like Excel spreadsheet data)
                      if (Array.isArray(jsonData)) {
                        console.log(
                          `[DEBUG] Converting JSON array to readable text for ${file.name}`,
                        );

                        // Format array of objects into a tabular text format
                        const formattedContent = jsonData
                          .map((row, index) => {
                            // Create a header from first row
                            if (index === 0) {
                              const header = Object.keys(row)
                                .map((key) => key.trim())
                                .join(' | ');
                              const divider = header
                                .replace(/[^|]/g, '-')
                                .replace(/\|/g, '|');
                              return `${header}\n${divider}\n${Object.values(
                                row,
                              )
                                .map((val) => String(val).trim())
                                .join(' | ')}`;
                            }
                            return Object.values(row)
                              .map((val) => String(val).trim())
                              .join(' | ');
                          })
                          .join('\n');

                        content = `Data from ${file.name}:\n\n${formattedContent}`;
                      }
                      // Handle single object
                      else if (typeof jsonData === 'object') {
                        console.log(
                          `[DEBUG] Converting JSON object to readable text for ${file.name}`,
                        );
                        content = `Data from ${file.name}:\n\n${Object.entries(
                          jsonData,
                        )
                          .map(
                            ([key, value]) =>
                              `${key.trim()}: ${String(value).trim()}`,
                          )
                          .join('\n')}`;
                      }

                      console.log(
                        `[DEBUG] Successfully formatted JSON content for ${file.name}`,
                      );
                    } catch (jsonError) {
                      console.warn(
                        `[DEBUG] Failed to parse JSON content for ${file.name}:`,
                        jsonError,
                      );
                      // Keep original content if JSON parsing fails
                    }
                  }

                  if (content.length > 150000) {
                    // Optional truncation
                    console.warn(
                      `Truncating extracted content for ${file.name}`,
                    );
                    content = `${content.substring(0, 150000)}... [Content truncated]`;
                  }
                  console.log(
                    `Successfully extracted content via n8n for: ${file.name}`,
                  );
                } else {
                  content = `[n8n Error processing ${file.name}: ${n8nResult.responseBody?.error || 'Unknown n8n error'}]`;
                  console.error(
                    `n8n processing error for ${file.name}:`,
                    n8nResult,
                  );
                }
              } else {
                const errorText = await n8nResponse.text();
                console.error(
                  `[DEBUG] N8N Error Response Body for ${file.name}: ${errorText}`,
                );

                content = `[Error calling n8n extractor for ${file.name}: ${n8nResponse.statusText}]`;
                console.error(
                  `n8n webhook call failed for ${file.name}: ${n8nResponse.status} ${n8nResponse.statusText}`,
                );
              }
            } catch (fetchError) {
              console.error(
                `[DEBUG] FETCH ERROR calling n8n for ${file.name}:`,
                fetchError,
              );

              console.error(
                `Error fetching n8n workflow for ${file.name}:`,
                fetchError,
              );
              content = `[Network error contacting file processor for ${file.name}]`;
            }
          } else {
            console.warn(
              `[DEBUG] Skipping n8n call for ${file.name} due to missing config.`,
            );

            console.warn(
              `n8n extraction workflow not configured. Using placeholder for ${file.name}.`,
            );
            content = `[File processor not configured for type: ${contentType}]`;
          }
          // --- End n8n Webhook Call Logic ---
        } else if (isImage) {
          console.log(`[DEBUG] Handling as image: ${file.name}`);

          // --- Keep Existing Image Handling Logic ---
          // For images, we just pass them through as the model can handle them
          console.log(`Passing image attachment through: ${file.name}`);
          content = `[Image: ${file.name}]`;
          // --- End Existing Image Handling Logic ---
        } else {
          console.warn(
            `[DEBUG] Unsupported type, skipping n8n: ${contentType}`,
          );

          // --- Handle Other Unexpected/Unsupported Types ---
          console.warn(
            `Unsupported attachment type encountered: ${contentType} for file ${file.name}`,
          );
          content = `[Unsupported Attachment Type: ${contentType}]`;
          // --- End Unsupported Type Handling ---
        }

        // --- End Conditional Processing ---

        // Add the result (extracted text or placeholder/error) to the context array
        contextFileContents.push({
          name: file.name,
          content: content, // Use the content variable populated by the relevant block above
        });

        console.log(
          `[DEBUG] Finished processing logic for attachment: ${file.name}`,
        );
        console.log(`Processed attachment: ${file.name}`);
      }
    } else {
      console.log(
        '[CORRECTED_DEBUG] Skipping attachment loop: No attachments found in user message.',
      );
    }

    console.log(
      '[DEBUG] Finished processing all attachments. Preparing final prompt context.',
    );
    console.log(
      '[DEBUG] Final contextFileContents:',
      JSON.stringify(contextFileContents),
    );

    // Create a modified system prompt with file context if needed
    let systemPromptWithContext = systemPrompt({ selectedChatModel });

    // Add file context to the system prompt if we have any
    if (contextFileContents.length > 0) {
      console.log('Injecting file context into system prompt');

      const fileContextString = `
--- User Uploaded Reference Files ---
${contextFileContents.map((f) => `File: ${f.name}\nContent:\n${f.content}\n---\n`).join('')}
--- End of Reference Files ---

Use the above files as reference material when answering the user's questions. If the information in the files is relevant to the question, be sure to incorporate that information in your response.
`;

      // Append the file context to the system prompt
      systemPromptWithContext = `${systemPromptWithContext}\n\n${fileContextString}`;
      console.log(
        '[DEBUG] System prompt being used:',
        `${systemPromptWithContext.substring(0, 500)}...`,
      ); // Log start of prompt
    }

    // Clone and sanitize messages to remove file attachments which the model doesn't support
    const sanitizedMessages = messages.map((message) => {
      // Create a new object without the experimental_attachments property
      const { experimental_attachments, ...rest } = message;

      // For user messages with file attachments, modify the content to include a reference
      if (
        message.role === 'user' &&
        experimental_attachments &&
        experimental_attachments.length > 0
      ) {
        // Get list of file names
        const fileNames = experimental_attachments
          .map((att) => att.name)
          .join(', ');

        // Clone parts array and add a note about files
        const newParts = [...(rest.parts || [])];
        const lastPartIndex = newParts.length - 1;

        // If last part is text, append to it; otherwise add a new text part
        if (lastPartIndex >= 0 && newParts[lastPartIndex].type === 'text') {
          const originalText = newParts[lastPartIndex].text;
          newParts[lastPartIndex] = {
            type: 'text',
            text: `${originalText}\n\n[Note: User uploaded file(s): ${fileNames}. Content has been extracted and included in context.]`,
          };
        } else {
          newParts.push({
            type: 'text',
            text: `[Note: User uploaded file(s): ${fileNames}. Content has been extracted and included in context.]`,
          });
        }

        return { ...rest, parts: newParts };
      }

      return rest;
    });

    console.log('[DEBUG] Sanitized messages to remove attachments.');

    return createDataStreamResponse({
      execute: (dataStream) => {
        try {
          console.log(
            '[DEBUG] Starting streamText execution with context length:',
            systemPromptWithContext.length,
          );

          const result = streamText({
            model: myProvider.languageModel(selectedChatModel),
            system: systemPromptWithContext, // Use the enhanced system prompt with context
            messages: sanitizedMessages, // Use sanitized messages without file attachments
            maxSteps: 10, // Increased from 5 to 10 to allow more reasoning steps
            experimental_activeTools: [
              'searchInternalKnowledgeBase',
              'listDocuments',
              'retrieveDocument',
              'queryDocumentRows',
              'tavilySearch',
              'getWeather',
              'createDocument',
              'updateDocument',
              'requestSuggestions',
              'googleCalendar',
            ],
            experimental_transform: smoothStream({
              chunking: 'word',
            }),
            experimental_generateMessageId: generateUUID,
            tools: {
              searchInternalKnowledgeBase,
              listDocuments,
              retrieveDocument,
              queryDocumentRows,
              tavilySearch,
              getWeather,
              googleCalendar,
              createDocument: createDocument({ session, dataStream }),
              updateDocument: updateDocument({ session, dataStream }),
              requestSuggestions: requestSuggestions({ session, dataStream }),
            },
            onFinish: async ({ response }) => {
              if (session.user?.id) {
                try {
                  const assistantId = getTrailingMessageId({
                    messages: response.messages.filter(
                      (message) => message.role === 'assistant',
                    ),
                  });

                  if (!assistantId) {
                    throw new Error('No assistant message found!');
                  }

                  const [, assistantMessage] = appendResponseMessages({
                    messages: [userMessage],
                    responseMessages: response.messages,
                  });

                  await saveMessages({
                    messages: [
                      {
                        id: assistantId,
                        chatId: id,
                        role: assistantMessage.role,
                        parts: assistantMessage.parts,
                        attachments:
                          assistantMessage.experimental_attachments ?? [],
                        createdAt: new Date(),
                      },
                    ],
                  });
                } catch (saveError) {
                  console.error('[DEBUG] Failed to save chat:', saveError);
                }
              }
            },
            experimental_telemetry: {
              isEnabled: isProductionEnvironment,
              functionId: 'stream-text',
            },
          });

          console.log('[DEBUG] streamText result created successfully');

          try {
            result.consumeStream();
            console.log('[DEBUG] streamText stream consumption started');

            result.mergeIntoDataStream(dataStream, {
              sendReasoning: true,
            });
            console.log('[DEBUG] Successfully merged into data stream');
          } catch (streamError) {
            console.error('[DEBUG] Error in stream processing:', streamError);
            // Just log the error, don't try to modify the stream directly
            // The onError handler will handle responding to the client
          }
        } catch (executeError) {
          console.error('[DEBUG] Error in execute function:', executeError);
          // Just log the error, don't try to modify the stream directly
          // The onError handler will handle responding to the client
        }
      },
      onError: (error) => {
        console.error(
          '[DEBUG] createDataStreamResponse onError triggered:',
          error,
        );
        return 'An error occurred while processing your request. Please try again.';
      },
    });
  } catch (error) {
    // Log the actual error before sending generic response
    console.error('[NEXT_STEP_DEBUG] API Route Outer Catch Error:', error);
    // Try to log raw body again if parsing failed
    try {
      console.error(
        '[NEXT_STEP_DEBUG] Error occurred, attempting to read raw body again:',
        await request
          .clone()
          .text()
          .catch(() => 'Could not clone/read body again'),
      );
    } catch (cloneError) {
      console.error(
        '[NEXT_STEP_DEBUG] Could not clone request to read body:',
        cloneError,
      );
    }
    return new Response('An error occurred while processing your request!', {
      status: 500,
    });
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  const session = await auth();

  if (!session || !session.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const chat = await getChatById({ id });

    if (chat.userId !== session.user.id) {
      return new Response('Unauthorized', { status: 401 });
    }

    await deleteChatById({ id });

    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request!', {
      status: 500,
    });
  }
}
