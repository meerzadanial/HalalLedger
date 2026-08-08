import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { deliveryEntriesApi, autocompleteApi } from '../services/api';
import type { DeliveryEntryFormData, RestaurantStatus } from '../types';
import { showSuccess, showError } from '../utils/toast';

/**
 * EntryWorkflow - Multi-step form for delivery entry
 * 
 * 6-Step workflow:
 * 1. Entry Date Selection (defaults to current date, validates no future dates)
 * 2. Restaurant Name Input (with autocomplete)
 * 3. Restaurant Status Selection (halal/non-halal)
 * 4. Fare Amount Input
 * 5. Cash Order Selection (yes/no)
 * 6. Cash Amount Input (conditional - only if Step 5 is "yes")
 * 
 * Supports both create and edit modes:
 * - Create mode: entryId is undefined
 * - Edit mode: entryId is provided, pre-fills form with existing data
 * 
 * Validates Requirements: 2.7, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4, 12.1, 12.2, 12.3, 12.4, 14.1, 14.2
 */

interface EntryWorkflowProps {
  entryId?: string; // Optional entry ID for edit mode
}

interface StepComponentProps {
  formData: DeliveryEntryFormData;
  onUpdate: (field: keyof DeliveryEntryFormData, value: any) => void;
  error?: string;
}

// Step 1: Entry Date Input (Requirements 12.1, 12.2, 12.3, 12.4)
function EntryDateStep({ formData, onUpdate, error }: StepComponentProps) {
  // Format date for HTML date input (YYYY-MM-DD)
  const formatDateForInput = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Get today's date in YYYY-MM-DD format for max attribute
  const today = formatDateForInput(new Date());
  const currentDateValue = formData.entryDate 
    ? formatDateForInput(new Date(formData.entryDate))
    : today;

  const handleDateChange = (dateString: string) => {
    if (dateString) {
      onUpdate('entryDate', new Date(dateString));
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-4">Entry Date</h2>
      <p className="text-gray-600 mb-6">When did this delivery occur?</p>
      
      <div>
        <input
          type="date"
          value={currentDateValue}
          max={today} // Requirement 12.4: Prevent future dates
          onChange={(e) => handleDateChange(e.target.value)}
          className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent ${
            error ? 'border-red-500' : 'border-gray-300'
          }`}
          autoFocus
        />
      </div>
      
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      
      <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>📅 Default:</strong> Today's date is automatically selected. You can change it to record past deliveries, but future dates are not allowed.
        </p>
      </div>
    </div>
  );
}

// Step 2: Restaurant Name Input with Autocomplete
function RestaurantNameStep({ formData, onUpdate, error }: StepComponentProps) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchSuggestions = async () => {
      if (formData.restaurantName.length < 2) {
        setSuggestions([]);
        return;
      }

      setIsLoading(true);
      try {
        const results = await autocompleteApi.getRestaurantSuggestions(formData.restaurantName);
        setSuggestions(results);
        setShowSuggestions(true);
      } catch (err) {
        console.error('Failed to fetch suggestions:', err);
        setSuggestions([]);
      } finally {
        setIsLoading(false);
      }
    };

    const debounceTimer = setTimeout(fetchSuggestions, 300);
    return () => clearTimeout(debounceTimer);
  }, [formData.restaurantName]);

  const handleSelectSuggestion = (name: string) => {
    onUpdate('restaurantName', name);
    setShowSuggestions(false);
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-4">Restaurant Name</h2>
      <p className="text-gray-600 mb-6">Enter the name of the restaurant</p>
      
      <div className="relative">
        <input
          type="text"
          value={formData.restaurantName}
          onChange={(e) => onUpdate('restaurantName', e.target.value)}
          onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent ${
            error ? 'border-red-500' : 'border-gray-300'
          }`}
          placeholder="e.g., McDonald's, Chipotle"
          maxLength={100}
          autoFocus
        />
        
        {isLoading && (
          <div className="absolute right-3 top-3 text-gray-400">
            Loading...
          </div>
        )}
        
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
            {suggestions.map((name, index) => (
              <button
                key={index}
                type="button"
                onClick={() => handleSelectSuggestion(name)}
                className="w-full px-4 py-2 text-left hover:bg-indigo-50 focus:bg-indigo-50 focus:outline-none"
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      
      <p className="mt-2 text-sm text-gray-500">
        {formData.restaurantName.length}/100 characters
      </p>
    </div>
  );
}

// Step 2: Restaurant Status Selection
function RestaurantStatusStep({ formData, onUpdate, error }: StepComponentProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-4">Restaurant Status</h2>
      <p className="text-gray-600 mb-6">Is this a halal or non-halal restaurant?</p>
      
      <div className="entry-workflow__option-grid">
        <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-all ${
          formData.restaurantStatus === 'halal'
            ? 'border-green-500 bg-green-50'
            : 'border-gray-300 hover:border-green-300'
        }`}>
          <input
            type="radio"
            name="restaurantStatus"
            value="halal"
            checked={formData.restaurantStatus === 'halal'}
            onChange={(e) => onUpdate('restaurantStatus', e.target.value as RestaurantStatus)}
            className="w-5 h-5 text-green-600 focus:ring-green-500"
          />
          <span className="ml-3 text-lg font-medium text-gray-900">Halal</span>
        </label>
        
        <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-all ${
          formData.restaurantStatus === 'non-halal'
            ? 'border-orange-500 bg-orange-50'
            : 'border-gray-300 hover:border-orange-300'
        }`}>
          <input
            type="radio"
            name="restaurantStatus"
            value="non-halal"
            checked={formData.restaurantStatus === 'non-halal'}
            onChange={(e) => onUpdate('restaurantStatus', e.target.value as RestaurantStatus)}
            className="w-5 h-5 text-orange-600 focus:ring-orange-500"
          />
          <span className="ml-3 text-lg font-medium text-gray-900">Non-Halal</span>
        </label>
      </div>
      
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// Step 3: Fare Amount Input
function FareAmountStep({ formData, onUpdate, error }: StepComponentProps) {
  const handleFareChange = (value: string) => {
    // Allow empty string or valid decimal
    if (value === '' || /^\d*\.?\d{0,2}$/.test(value)) {
      onUpdate('fareAmount', value === '' ? 0 : parseFloat(value));
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-4">Fare Amount</h2>
      <p className="text-gray-600 mb-6">Enter the delivery fare amount</p>
      
      <div className="relative">
        <span className="absolute left-4 top-3 text-gray-500 text-lg">RM</span>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={formData.fareAmount || ''}
          onChange={(e) => handleFareChange(e.target.value)}
          className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent ${
            error ? 'border-red-500' : 'border-gray-300'
          }`}
          placeholder="0.00"
          autoFocus
        />
      </div>
      
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      
      <p className="mt-2 text-sm text-gray-500">
        Enter amount with up to 2 decimal places
      </p>
    </div>
  );
}

// Step 4: Cash Order Selection
function CashOrderStep({ formData, onUpdate, error }: StepComponentProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-4">Cash Order</h2>
      <p className="text-gray-600 mb-6">Did you receive cash for this order?</p>
      
      <div className="entry-workflow__option-grid">
        <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-all ${
          formData.hasCashOrder === true
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 hover:border-blue-300'
        }`}>
          <input
            type="radio"
            name="hasCashOrder"
            value="yes"
            checked={formData.hasCashOrder === true}
            onChange={() => onUpdate('hasCashOrder', true)}
            className="w-5 h-5 text-blue-600 focus:ring-blue-500"
          />
          <span className="ml-3 text-lg font-medium text-gray-900">Yes</span>
        </label>
        
        <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-all ${
          formData.hasCashOrder === false
            ? 'border-gray-500 bg-gray-50'
            : 'border-gray-300 hover:border-gray-400'
        }`}>
          <input
            type="radio"
            name="hasCashOrder"
            value="no"
            checked={formData.hasCashOrder === false}
            onChange={() => onUpdate('hasCashOrder', false)}
            className="w-5 h-5 text-gray-600 focus:ring-gray-500"
          />
          <span className="ml-3 text-lg font-medium text-gray-900">No</span>
        </label>
      </div>
      
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// Step 5: Cash Amount Input (conditional)
function CashAmountStep({ formData, onUpdate, error }: StepComponentProps) {
  const handleCashChange = (value: string) => {
    // Allow empty string or valid decimal
    if (value === '' || /^\d*\.?\d{0,2}$/.test(value)) {
      onUpdate('cashAmount', value === '' ? undefined : parseFloat(value));
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-4">Cash Amount</h2>
      <p className="text-gray-600 mb-6">Enter the cash amount received</p>
      
      <div className="relative">
        <span className="absolute left-4 top-3 text-gray-500 text-lg">RM</span>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={formData.cashAmount || ''}
          onChange={(e) => handleCashChange(e.target.value)}
          className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent ${
            error ? 'border-red-500' : 'border-gray-300'
          }`}
          placeholder="0.00"
          autoFocus
        />
      </div>
      
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      
      <p className="mt-2 text-sm text-gray-500">
        Enter amount with up to 2 decimal places
      </p>
    </div>
  );
}

// Main EntryWorkflow Component
export default function EntryWorkflow({ entryId }: EntryWorkflowProps) {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<DeliveryEntryFormData>({
    restaurantName: '',
    restaurantStatus: 'halal',
    fareAmount: 0,
    hasCashOrder: false,
    cashAmount: undefined,
    entryDate: new Date(), // Requirement 12.1: Default to current date
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [isLoadingEntry, setIsLoadingEntry] = useState(false);
  const [loadError, setLoadError] = useState('');
  const isEditMode = !!entryId;

  // Load existing entry data if in edit mode (Requirement 14.1)
  useEffect(() => {
    const loadEntry = async () => {
      if (!entryId) return;

      setIsLoadingEntry(true);
      setLoadError('');

      try {
        const entry = await deliveryEntriesApi.getById(entryId);
        
        // Pre-fill form with existing entry data
        setFormData({
          restaurantName: entry.restaurantName,
          restaurantStatus: entry.restaurantStatus,
          fareAmount: entry.fareAmount,
          hasCashOrder: entry.hasCashOrder,
          cashAmount: entry.cashAmount,
          entryDate: new Date(entry.entryDate),
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to load entry';
        setLoadError(errorMessage);
        
        // If entry not found or unauthorized, redirect to dashboard
        if (errorMessage.includes('not found') || errorMessage.includes('Unauthorized')) {
          setTimeout(() => navigate('/dashboard'), 2000);
        }
      } finally {
        setIsLoadingEntry(false);
      }
    };

    loadEntry();
  }, [entryId, navigate]);

  // Calculate total steps (6 if cash order, 5 if not)
  const totalSteps = formData.hasCashOrder ? 6 : 5;

  const handleUpdate = (field: keyof DeliveryEntryFormData, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error for this field
    setErrors((prev) => {
      const newErrors = { ...prev };
      delete newErrors[field];
      return newErrors;
    });
  };

  const validateStep = (step: number): boolean => {
    const newErrors: Record<string, string> = {};

    switch (step) {
      case 1:
        // Validate entry date (Requirements 12.3, 12.4)
        if (!formData.entryDate) {
          newErrors.entryDate = 'Entry date is required';
        } else {
          const entryDate = new Date(formData.entryDate);
          const today = new Date();
          today.setHours(0, 0, 0, 0); // Reset time to compare dates only
          entryDate.setHours(0, 0, 0, 0);
          
          if (entryDate > today) {
            newErrors.entryDate = 'Entry date cannot be in the future';
          }
        }
        break;

      case 2:
        if (!formData.restaurantName || formData.restaurantName.trim().length === 0) {
          newErrors.restaurantName = 'Restaurant name is required';
        } else if (formData.restaurantName.length > 100) {
          newErrors.restaurantName = 'Restaurant name must be 100 characters or less';
        }
        break;

      case 3:
        if (!formData.restaurantStatus) {
          newErrors.restaurantStatus = 'Please select a restaurant status';
        }
        break;

      case 4:
        if (!formData.fareAmount || formData.fareAmount <= 0) {
          newErrors.fareAmount = 'Fare amount must be greater than 0';
        } else if (!/^\d+(\.\d{1,2})?$/.test(formData.fareAmount.toString())) {
          newErrors.fareAmount = 'Fare amount must have at most 2 decimal places';
        }
        break;

      case 5:
        if (formData.hasCashOrder === undefined || formData.hasCashOrder === null) {
          newErrors.hasCashOrder = 'Please select yes or no';
        }
        break;

      case 6:
        if (formData.hasCashOrder) {
          if (!formData.cashAmount || formData.cashAmount <= 0) {
            newErrors.cashAmount = 'Cash amount must be greater than 0';
          } else if (!/^\d+(\.\d{1,2})?$/.test(formData.cashAmount.toString())) {
            newErrors.cashAmount = 'Cash amount must have at most 2 decimal places';
          }
        }
        break;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (validateStep(currentStep)) {
      // If on step 5 and no cash order, skip to submission
      if (currentStep === 5 && !formData.hasCashOrder) {
        handleSubmit();
      } else if (currentStep < totalSteps) {
        setCurrentStep(currentStep + 1);
      }
    }
  };

  const handlePrevious = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSubmit = async () => {
    // Validate all steps
    let isValid = true;
    for (let step = 1; step <= totalSteps; step++) {
      if (!validateStep(step)) {
        isValid = false;
        break;
      }
    }

    if (!isValid) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');

    try {
      // Call PUT if editing, POST if creating (Requirement 14.2)
      if (isEditMode && entryId) {
        await deliveryEntriesApi.update(entryId, formData);
        showSuccess('Entry updated successfully!');
      } else {
        await deliveryEntriesApi.create(formData);
        showSuccess('Entry created successfully!');
      }
      // Success - redirect to dashboard
      navigate('/dashboard');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : `Failed to ${isEditMode ? 'update' : 'create'} entry`;
      setSubmitError(errorMessage);
      showError(errorMessage);
      setIsSubmitting(false);
    }
  };

  const renderStep = () => {
    const stepProps = {
      formData,
      onUpdate: handleUpdate,
    };

    switch (currentStep) {
      case 1:
        return <EntryDateStep {...stepProps} error={errors.entryDate} />;
      case 2:
        return <RestaurantNameStep {...stepProps} error={errors.restaurantName} />;
      case 3:
        return <RestaurantStatusStep {...stepProps} error={errors.restaurantStatus} />;
      case 4:
        return <FareAmountStep {...stepProps} error={errors.fareAmount} />;
      case 5:
        return <CashOrderStep {...stepProps} error={errors.hasCashOrder} />;
      case 6:
        return <CashAmountStep {...stepProps} error={errors.cashAmount} />;
      default:
        return null;
    }
  };

  return (
    <div className="entry-workflow min-h-screen bg-gray-50 py-6 px-4 sm:px-6 sm:py-10 lg:px-8">
      <div className="entry-workflow__container max-w-2xl mx-auto">
        {/* Loading State */}
        {isLoadingEntry && (
          <div className="text-center py-12">
            <div className="text-gray-600">Loading entry...</div>
          </div>
        )}

        {/* Load Error State */}
        {loadError && !isLoadingEntry && (
          <div className="mb-4 rounded-md bg-red-50 p-4">
            <div className="text-sm text-red-800">{loadError}</div>
            <div className="mt-2 text-xs text-red-600">
              Redirecting to dashboard...
            </div>
          </div>
        )}

        {/* Main Form - Only show if not loading and no load error */}
        {!isLoadingEntry && !loadError && (
          <>
            {/* Header */}
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold text-gray-900">
                {isEditMode ? 'Edit Delivery Entry' : 'New Delivery Entry'}
              </h1>
            </div>

            {/* Progress Indicator */}
            <div className="mb-8">
              {/* Step text */}
              <div className="text-center mb-4">
                <span className="text-sm font-medium text-gray-700">
                  Step {currentStep} of {totalSteps}
                </span>
              </div>
              
              {/* Progress bar */}
              <div className="w-full bg-gray-200 rounded-full h-2 mb-4">
                <div
                  className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${(currentStep / totalSteps) * 100}%` }}
                />
              </div>

              {/* Step dots (optional - mobile friendly) */}
              <div className="flex items-center justify-center gap-2">
                {Array.from({ length: totalSteps }, (_, i) => i + 1).map((step) => (
                  <div
                    key={step}
                    className={`w-2 h-2 rounded-full transition-all duration-300 ${
                      step < currentStep
                        ? 'bg-green-500'
                        : step === currentStep
                        ? 'bg-indigo-600 w-3 h-3'
                        : 'bg-gray-300'
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* Step Content */}
            <div className="entry-workflow__card bg-white shadow-lg rounded-lg p-8 mb-6">
              {renderStep()}
            </div>

            {/* Error Message */}
            {submitError && (
              <div className="mb-4 rounded-md bg-red-50 p-4">
                <div className="text-sm text-red-800">{submitError}</div>
              </div>
            )}

            {/* Navigation Buttons */}
            <div className="entry-workflow__actions flex justify-between">
              <button
                type="button"
                onClick={handlePrevious}
                disabled={currentStep === 1}
                className={`px-6 py-3 rounded-lg font-medium ${
                  currentStep === 1
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-gray-300 text-gray-700 hover:bg-gray-400'
                }`}
              >
                Previous
              </button>

              {currentStep === totalSteps ? (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  className="px-6 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:bg-gray-400"
                >
                  {isSubmitting ? 'Submitting...' : isEditMode ? 'Update' : 'Submit'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleNext}
                  className="px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700"
                >
                  Next
                </button>
              )}
            </div>

            {/* Cancel Button */}
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => navigate('/dashboard')}
                className="text-gray-600 hover:text-gray-900 text-sm font-medium"
              >
                Cancel and return to dashboard
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
