import { useParams } from 'react-router-dom';
import EntryWorkflow from '../components/EntryWorkflow';

/**
 * EntryPage - Page wrapper for the delivery entry workflow
 * 
 * Renders the EntryWorkflow component for creating new delivery entries
 * or editing existing ones.
 * 
 * URL Parameters:
 * - id (optional): Entry ID for edit mode
 * 
 * Validates Requirements: 2.7, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4, 14.1, 14.2
 */
export default function EntryPage() {
  const { id } = useParams<{ id: string }>();
  
  return <EntryWorkflow entryId={id} />;
}
